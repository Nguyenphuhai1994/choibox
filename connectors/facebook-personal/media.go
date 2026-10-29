// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
 "context"
 "crypto/rand"
 "encoding/base64"
 "encoding/hex"
 "errors"
 "io"
 "net/http"
 "net/url"
 "strings"
 "time"

 "go.mau.fi/mautrix-meta/pkg/messagix/table"
 "go.mau.fi/whatsmeow"
 "go.mau.fi/whatsmeow/proto/waMediaTransport"
)
const maxMediaBytes=25*1024*1024
type mediaDescriptor struct {
 Encrypted bool `json:"encrypted"`
 URL string `json:"url,omitempty"`
 Kind string `json:"kind"`
 Mime string `json:"mime"`
 Name string `json:"name"`
 Size uint64 `json:"size"`
 Integral *waMediaTransport.WAMediaTransport_Integral `json:"integral,omitempty"`
}
type mediaPayload struct{data []byte;expires time.Time}
func encryptedMedia(t *waMediaTransport.WAMediaTransport,kind string)*mediaDescriptor{
 if t==nil||t.GetIntegral()==nil{return nil}
 mime:=t.GetAncillary().GetMimetype();name:="Ảnh Messenger.jpg"
 if kind=="video"{name="Video Messenger.mp4";if mime==""{mime="video/mp4"}}else if mime==""{mime="image/jpeg"}
 return &mediaDescriptor{Encrypted:true,Kind:kind,Mime:mime,Name:name,Size:t.GetAncillary().GetFileLength(),Integral:t.GetIntegral()}
}
func plainMedia(w *table.WrappedMessage)*mediaDescriptor{
 for _,a:=range w.BlobAttachments{
  if a.PlayableUrl!=""{mime:=a.PlayableUrlMimeType;if mime==""{mime=a.AttachmentMimeType};kind:="image";if strings.HasPrefix(mime,"video/")||a.PlayableDurationMs>0{kind="video"};if kind=="image"&&!strings.HasPrefix(mime,"image/"){continue};size:=a.Filesize;if size<0{size=0};return &mediaDescriptor{URL:a.PlayableUrl,Kind:kind,Mime:mime,Name:a.Filename,Size:uint64(size)}}
  if a.PreviewUrl!=""{return &mediaDescriptor{URL:a.PreviewUrl,Kind:"image",Mime:"image/jpeg",Name:"Ảnh Messenger.jpg"}}
 }
 for _,a:=range w.Attachments{
  if a.PlayableUrl!=""{mime:=a.PlayableUrlMimeType;kind:="image";if strings.HasPrefix(mime,"video/")||a.PlayableDurationMs>0{kind="video"};if kind=="image"&&!strings.HasPrefix(mime,"image/"){continue};size:=a.Filesize;if size<0{size=0};return &mediaDescriptor{URL:a.PlayableUrl,Kind:kind,Mime:mime,Name:a.Filename,Size:uint64(size)}}
  if a.PreviewUrl!=""{return &mediaDescriptor{URL:a.PreviewUrl,Kind:"image",Mime:"image/jpeg",Name:"Ảnh Messenger.jpg"}}
 }
 return nil
}
func validateEncryptedMedia(m *mediaDescriptor)error{
 if m==nil||!m.Encrypted||(m.Kind!="image"&&m.Kind!="video")||m.Size>maxMediaBytes{return errors.New("INVALID_MEDIA")}
 t:=m.Integral
 if t==nil||len(t.GetMediaKey())!=32||len(t.GetFileSHA256())!=32||len(t.GetFileEncSHA256())!=32||!strings.HasPrefix(t.GetDirectPath(),"/")||strings.HasPrefix(t.GetDirectPath(),"//")||len(t.GetDirectPath())>8192{return errors.New("INVALID_MEDIA_TRANSPORT")}
 return nil
}
func allowedMediaURL(u *url.URL)bool{
 if u==nil||u.Scheme!="https"||u.User!=nil||(u.Port()!=""&&u.Port()!="443"){return false}
 h:=strings.ToLower(u.Hostname())
 for _,d:=range []string{"facebook.com","fbcdn.net","fbsbx.com","whatsapp.net"}{if h==d||strings.HasSuffix(h,"."+d){return true}}
 return false
}
type limitedMediaBody struct{io.ReadCloser;n int64}
func (b *limitedMediaBody)Read(p []byte)(int,error){
 if b.n<=0{return 0,errors.New("MEDIA_TOO_LARGE")}
 if int64(len(p))>b.n{p=p[:b.n]}
 n,err:=b.ReadCloser.Read(p);b.n-=int64(n);return n,err
}
type limitedMediaTransport struct{}
func (limitedMediaTransport)RoundTrip(r *http.Request)(*http.Response,error){
 if !allowedMediaURL(r.URL){return nil,errors.New("MEDIA_HOST_REJECTED")}
 res,err:=http.DefaultTransport.RoundTrip(r);if err!=nil{return nil,err}
 if res.ContentLength>maxMediaBytes+65536{res.Body.Close();return nil,errors.New("MEDIA_TOO_LARGE")}
 res.Body=&limitedMediaBody{ReadCloser:res.Body,n:maxMediaBytes+65536};return res,nil
}
func mediaHTTPClient()*http.Client{return &http.Client{Transport:limitedMediaTransport{},Timeout:45*time.Second,CheckRedirect:func(r *http.Request,via []*http.Request)error{if len(via)>3||!allowedMediaURL(r.URL){return errors.New("MEDIA_REDIRECT_REJECTED")};return nil}}}
func (c *connector) mediaAction(ctx context.Context,method string,a args)(any,error){
 if c.downloads==nil{c.downloads=map[string]mediaPayload{}}
 for token,p:=range c.downloads{if time.Now().After(p.expires){delete(c.downloads,token)}}
 switch method{
 case "media.prepare":
  if err:=validateEncryptedMedia(a.Media);err!=nil{return nil,err}
  if c.encrypted==nil||!c.encrypted.IsConnected(){return nil,errors.New("ENCRYPTED_NOT_CONNECTED")}
  if len(c.downloads)>=2{return nil,errors.New("MEDIA_BUSY")}
  typ:=whatsmeow.MediaImage;if a.Media.Kind=="video"{typ=whatsmeow.MediaVideo}
  data,err:=c.encrypted.DownloadFB(ctx,a.Media.Integral,typ);if err!=nil{return nil,errors.New("MEDIA_DOWNLOAD_FAILED")}
  if len(data)==0||len(data)>maxMediaBytes{return nil,errors.New("MEDIA_TOO_LARGE")}
  var bytes [16]byte;if _,err=rand.Read(bytes[:]);err!=nil{return nil,errors.New("MEDIA_TOKEN_FAILED")}
  token:=hex.EncodeToString(bytes[:]);c.downloads[token]=mediaPayload{data:data,expires:time.Now().Add(2*time.Minute)}
  return map[string]any{"token":token,"size":len(data),"mime":a.Media.Mime},nil
 case "media.chunk":
  p,ok:=c.downloads[a.Token];if !ok||a.Offset<0||a.Offset>=len(p.data){return nil,errors.New("MEDIA_CHUNK_INVALID")}
  end:=a.Offset+256*1024;if end>len(p.data){end=len(p.data)}
  return map[string]any{"data":base64.StdEncoding.EncodeToString(p.data[a.Offset:end]),"next":end,"done":end==len(p.data)},nil
 case "media.release":delete(c.downloads,a.Token);return map[string]any{"ok":true},nil
 }
 return nil,errors.New("UNSUPPORTED_METHOD")
}
