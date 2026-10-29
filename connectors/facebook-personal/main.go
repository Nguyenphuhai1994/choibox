// Choibox personal Messenger connector. Integration code written for Choibox.
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
 "bufio"
 "context"
 "database/sql"
 "encoding/json"
 "errors"
 "io"
 "os"
 "path/filepath"
 "strconv"
 "sync"
 "time"

 "github.com/rs/zerolog"
 zlog "github.com/rs/zerolog/log"
 "go.mau.fi/mautrix-meta/pkg/messagix"
 "go.mau.fi/mautrix-meta/pkg/messagix/cookies"
 "go.mau.fi/mautrix-meta/pkg/messagix/methods"
 "go.mau.fi/mautrix-meta/pkg/messagix/socket"
 "go.mau.fi/mautrix-meta/pkg/messagix/table"
 "go.mau.fi/mautrix-meta/pkg/messagix/types"
 "go.mau.fi/whatsmeow"
 "go.mau.fi/whatsmeow/store/sqlstore"
 wt "go.mau.fi/whatsmeow/types"
 we "go.mau.fi/whatsmeow/types/events"
 "go.mau.fi/whatsmeow/proto/waConsumerApplication"
 "go.mau.fi/whatsmeow/proto/waCommon"
 "google.golang.org/protobuf/proto"
 _ "modernc.org/sqlite"
)

type request struct { ID int64; Method string; Params json.RawMessage }
type args struct { Input map[string]string; Cookies map[cookies.MetaCookieName]string; Peer,Text string; Encrypted bool; Media *mediaDescriptor; Token string; Offset int }
type contact struct { Name,Avatar string }
type thread struct { Name string; Encrypted,Group bool }
type connector struct {
 loginContext context.Context
 native *messagix.Client
 client *messagix.Client
 encrypted *whatsmeow.Client
 downloads map[string]mediaPayload
 database *sql.DB
 userID string
 contacts map[string]contact
 threads map[string]thread
 mu sync.RWMutex
}
var outputMu sync.Mutex
func emit(v any){outputMu.Lock();defer outputMu.Unlock();json.NewEncoder(os.Stdout).Encode(v)}
func event(kind string,data any){emit(map[string]any{"event":kind,"data":data})}
func validID(s string)bool{if len(s)<1||len(s)>24{return false};for _,r:=range s{if r<'0'||r>'9'{return false}};return true}
func (c *connector) process(t *table.LSTable,historical bool){
 if t==nil{return}
 c.mu.Lock()
 for _,p:=range t.LSVerifyContactRowExists{c.contacts[strconv.FormatInt(p.ContactId,10)]=contact{p.Name,p.ProfilePictureUrl}}
 for _,p:=range t.LSDeleteThenInsertThread{c.threads[strconv.FormatInt(p.ThreadKey,10)]=thread{p.ThreadName,p.ThreadType==table.ENCRYPTED_OVER_WA_ONE_TO_ONE||p.ThreadType==table.ENCRYPTED_OVER_WA_GROUP,p.ThreadType==table.ENCRYPTED_OVER_WA_GROUP||p.ThreadType==table.GROUP_THREAD}}
 c.mu.Unlock()
 history,insert:=t.WrapMessages()
 if historical {n:=0;for _,batch:=range history{for _,m:=range batch.Messages{if n>=200{break};c.message(m,true);n++}}}
 for _,m:=range insert{c.message(m,historical)}
}
func (c *connector) message(w *table.WrappedMessage,historical bool){
 if w==nil{return};m:=w.LSInsertMessage
 if m==nil||m.MessageId==""{return}
 peer:=strconv.FormatInt(m.ThreadKey,10);author:=strconv.FormatInt(m.SenderId,10)
 c.mu.RLock();th:=c.threads[peer];person:=c.contacts[peer];sender:=c.contacts[author];c.mu.RUnlock()
 name:=th.Name;if name==""{name=person.Name};if name==""{name="Facebook "+peer}
 text:=m.Text;if text==""{text="[Nội dung đính kèm trên Messenger]"}
 event("message",map[string]any{"id":m.MessageId,"peer":peer,"text":text,"name":name,"author":author,"author_name":sender.Name,"avatar":person.Avatar,"time":m.TimestampMs,"self":author==c.userID,"historical":historical,"encrypted":th.Encrypted,"group":th.Group,"media":plainMedia(w)})
}
func (c *connector) onMeta(ctx context.Context,e any){
 switch v:=e.(type){
 case *table.LSTable:c.process(v,false)
 case *messagix.ConnectedEvent,*messagix.ReconnectedEvent:event("state",map[string]any{"connected":true})
 case *messagix.TransientDisconnectEvent:event("state",map[string]any{"connected":false})
 case *messagix.PermanentErrorEvent:event("state",map[string]any{"connected":false,"relogin":true})
 }
}
func (c *connector) onEncrypted(e any){
 switch v:=e.(type){
 case *we.Connected:event("encrypted",map[string]any{"connected":true})
 case *we.Disconnected:event("encrypted",map[string]any{"connected":false})
 case *we.FBMessage:
  app:=v.GetConsumerApplication();if app==nil{return}
  content:=app.GetPayload().GetContent();text:="";var media *mediaDescriptor
  if content!=nil{switch body:=content.GetContent().(type){
   case *waConsumerApplication.ConsumerApplication_Content_ImageMessage:
    image,err:=body.ImageMessage.Decode();if err==nil{media=encryptedMedia(image.GetIntegral().GetTransport(),"image")};text=body.ImageMessage.GetCaption().GetText()
   case *waConsumerApplication.ConsumerApplication_Content_VideoMessage:
    video,err:=body.VideoMessage.Decode();if err==nil{media=encryptedMedia(video.GetIntegral().GetTransport(),"video")};text=body.VideoMessage.GetCaption().GetText()
   case *waConsumerApplication.ConsumerApplication_Content_MessageText:text=body.MessageText.GetText()
   case *waConsumerApplication.ConsumerApplication_Content_ExtendedTextMessage:text=body.ExtendedTextMessage.GetText().GetText()
  }}
  if text==""{if media!=nil&&media.Kind=="image"{text="[Ảnh đính kèm]"}else if media!=nil&&media.Kind=="video"{text="[Video đính kèm]"}else{text="[Tin nhắn mã hoá không phải văn bản]"}}
  peer:=v.Info.Chat.User
  c.mu.Lock();th:=c.threads[peer];th.Encrypted=true;th.Group=v.Info.IsGroup;c.threads[peer]=th;person:=c.contacts[peer];c.mu.Unlock()
  name:=th.Name;if name==""{name=person.Name};if name==""{name="Messenger "+peer}
  event("message",map[string]any{"id":v.Info.ID,"peer":peer,"text":text,"name":name,"author":v.Info.Sender.User,"time":v.Info.Timestamp.UnixMilli(),"self":v.Info.IsFromMe,"historical":false,"encrypted":true,"group":v.Info.IsGroup,"avatar":person.Avatar,"media":media})
 }
}
func (c *connector) connect(ctx context.Context,a args)(any,error){
 if c.client!=nil{return nil,errors.New("ALREADY_CONNECTED")}
 cookie:=&cookies.Cookies{Platform:types.Facebook};delete(a.Cookies,cookies.MetaCookieName("i_user"));cookie.UpdateValues(a.Cookies)
 cli:=messagix.NewClient(cookie,zerolog.Nop(),&messagix.Config{})
 user,t,err:=cli.LoadMessagesPage(ctx);if err!=nil{return nil,errors.New("MESSENGER_BOOTSTRAP_FAILED")}
 uid:=strconv.FormatInt(user.GetFBID(),10);if !validID(uid){return nil,errors.New("INVALID_ACCOUNT")}
 c.userID=uid;c.client=cli;cli.SetEventHandler(c.onMeta)
 c.process(t,true)
 if err=cli.Connect(context.Background());err!=nil{return nil,errors.New("MESSENGER_CONNECT_FAILED")}
 return map[string]any{"id":uid,"name":user.GetName(),"avatar":user.GetAvatarURL(),"cookies":cookie.GetAll()},nil
}
func (c *connector) enableEncrypted(ctx context.Context)(any,error){
 if c.client==nil{return nil,errors.New("NOT_CONNECTED")}
 if c.encrypted!=nil{return map[string]any{"connected":c.encrypted.IsConnected()},nil}
 // Only the fixed, private working directory chosen by Choibox is used.
 database,err:=sql.Open("sqlite","file:"+filepath.Join(".", "device-"+c.userID+".sqlite")+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
 if err!=nil{return nil,errors.New("DEVICE_STORE_FAILED")}
 database.SetMaxOpenConns(1)
 c.database=database
 store:=sqlstore.NewWithDB(database,"sqlite3",nil)
 if err=store.Upgrade(ctx);err!=nil{return nil,errors.New("DEVICE_STORE_UPGRADE_FAILED")}
 dev,err:=store.GetFirstDevice(ctx);if err!=nil{return nil,errors.New("DEVICE_LOAD_FAILED")}
 c.client.SetDevice(dev)
 if dev.ID==nil{fbid,_:=strconv.ParseInt(c.userID,10,64);if err=c.client.RegisterE2EE(ctx,fbid);err!=nil{return nil,errors.New("DEVICE_REGISTRATION_FAILED")};if err=dev.Save(ctx);err!=nil{return nil,errors.New("DEVICE_SAVE_FAILED")}}
 enc,err:=c.client.PrepareE2EEClient();if err!=nil{return nil,errors.New("ENCRYPTED_PREPARE_FAILED")}
 enc.SetMediaHTTPClient(mediaHTTPClient())
 enc.AddEventHandler(c.onEncrypted)
 c.encrypted=enc
 if err=enc.Connect();err!=nil{c.encrypted=nil;return nil,errors.New("ENCRYPTED_CONNECT_FAILED")}
 return map[string]any{"connected":enc.IsConnected()},nil
}
func (c *connector) send(ctx context.Context,a args)(any,error){
 if !validID(a.Peer)||len(a.Text)==0||len(a.Text)>12000{return nil,errors.New("INVALID_MESSAGE")}
 c.mu.RLock();th,known:=c.threads[a.Peer];c.mu.RUnlock()
 // Never silently downgrade an encrypted conversation to ordinary transport.
 if a.Encrypted||th.Encrypted{
  if c.encrypted==nil||!c.encrypted.IsConnected(){return nil,errors.New("ENCRYPTED_NOT_CONNECTED")}
  server:=wt.MessengerServer;if th.Group{server=wt.GroupServer}
  message:=&waConsumerApplication.ConsumerApplication{Payload:&waConsumerApplication.ConsumerApplication_Payload{Payload:&waConsumerApplication.ConsumerApplication_Payload_Content{Content:&waConsumerApplication.ConsumerApplication_Content{Content:&waConsumerApplication.ConsumerApplication_Content_MessageText{MessageText:&waCommon.MessageText{Text:proto.String(a.Text)}}}}}}
  result,err:=c.encrypted.SendFBMessage(ctx,wt.NewJID(a.Peer,server),message,nil)
  if err!=nil{return nil,errors.New("SEND_UNCONFIRMED")}
  return map[string]any{"message_id":result.ID},nil
 }
 if !known{return nil,errors.New("UNKNOWN_THREAD_TRANSPORT")}
 if c.client==nil||!c.client.IsConnected(){return nil,errors.New("NOT_CONNECTED")}
 id,_:=strconv.ParseInt(a.Peer,10,64);otid:=methods.GenerateEpochID()
 result,err:=c.client.ExecuteTasks(ctx,&socket.SendMessageTask{ThreadId:id,Otid:otid,Text:a.Text,SendType:table.TEXT,Source:table.MESSENGER_INBOX_RECENT_THREADS,SyncGroup:1,InitiatingSource:table.FACEBOOK_INBOX})
 if err!=nil{return nil,errors.New("SEND_UNCONFIRMED")}
 for _,r:=range result.LSReplaceOptimsiticMessage{if r.OfflineThreadingId==strconv.FormatInt(otid,10)&&r.MessageId!=""{return map[string]any{"message_id":r.MessageId},nil}}
 return nil,errors.New("SEND_UNCONFIRMED")
}
func (c *connector) handle(ctx context.Context,r request)(any,error){
 var a args;if len(r.Params)>0&&json.Unmarshal(r.Params,&a)!=nil{return nil,errors.New("INVALID_INPUT")}
 switch r.Method{
 case "hello":return map[string]any{"protocol":1,"name":"choibox-facebook-personal","upstream":"baffb16564deabf691271bcb65168d08f1d49470"},nil
 case "login.start":
  ck:=&cookies.Cookies{Platform:types.MessengerLiteIOS};ck.UpdateValues(map[cookies.MetaCookieName]string{})
  c.native=messagix.NewClient(ck,zerolog.Nop(),&messagix.Config{})
  fallthrough
 case "login.submit","login.wait","login.back":
  if c.native==nil{return nil,errors.New("LOGIN_NOT_STARTED")}
  if r.Method=="login.back"{if err:=c.native.MessengerLite.CancelLoginStep(c.loginContext);err!=nil{return nil,errors.New("LOGIN_BACK_FAILED")}}
  step,ck,err:=c.native.MessengerLite.DoLoginSteps(c.loginContext,a.Input)
  if err!=nil{return nil,errors.New("LOGIN_STEP_FAILED")}
  if ck!=nil{c.native=nil;return map[string]any{"complete":true,"cookies":ck.GetAll()},nil}
  return map[string]any{"step":step},nil
 case "connect":return c.connect(ctx,a)
 case "encrypted.connect":return c.enableEncrypted(ctx)
 case "send":return c.send(ctx,a)
 case "media.prepare","media.chunk","media.release":return c.mediaAction(ctx,r.Method,a)
 case "state":return map[string]any{"connected":c.client!=nil&&c.client.IsConnected(),"encrypted":c.encrypted!=nil&&c.encrypted.IsConnected()},nil
 default:return nil,errors.New("UNSUPPORTED_METHOD")
 }
}
func main(){
 os.Chmod(".",0700);zerolog.SetGlobalLevel(zerolog.Disabled);zlog.Logger=zerolog.New(io.Discard)
 c:=&connector{loginContext:context.Background(),contacts:map[string]contact{},threads:map[string]thread{}}
 scanner:=bufio.NewScanner(os.Stdin);scanner.Buffer(make([]byte,4096),256*1024)
 for scanner.Scan(){func(){
  var r request;if json.Unmarshal(scanner.Bytes(),&r)!=nil{return}
  defer func(){if recover()!=nil{emit(map[string]any{"id":r.ID,"ok":false,"error":"CONNECTOR_STEP_FAILED"})}}()
  ctx,cancel:=context.WithTimeout(context.Background(),60*time.Second);defer cancel()
  data,err:=c.handle(ctx,r)
  if err!=nil{emit(map[string]any{"id":r.ID,"ok":false,"error":err.Error()})}else{emit(map[string]any{"id":r.ID,"ok":true,"data":data})}
 }()}
 if c.encrypted!=nil{c.encrypted.Disconnect()};if c.client!=nil{c.client.Disconnect()};if c.database!=nil{c.database.Close()}
}
