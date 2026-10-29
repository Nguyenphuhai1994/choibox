// SPDX-License-Identifier: AGPL-3.0-or-later
package main
import(
 "bytes"
 "context"
 "encoding/base64"
 "io"
 "net/url"
 "testing"
 "time"
 "go.mau.fi/mautrix-meta/pkg/messagix/table"
 "go.mau.fi/whatsmeow/proto/waMediaTransport"
 "google.golang.org/protobuf/proto"
)
func TestEncryptedMediaMetadataMustBeCompleteAndBounded(t *testing.T){
 integral:=&waMediaTransport.WAMediaTransport_Integral{MediaKey:make([]byte,32),FileSHA256:make([]byte,32),FileEncSHA256:make([]byte,32),DirectPath:proto.String("/media?token=private")}
 d:=&mediaDescriptor{Encrypted:true,Kind:"image",Size:100,Integral:integral}
 if err:=validateEncryptedMedia(d);err!=nil{t.Fatal(err)}
 d.Size=maxMediaBytes+1;if validateEncryptedMedia(d)==nil{t.Fatal("oversized media accepted")};d.Size=10
 integral.DirectPath=proto.String("https://evil.test/x");if validateEncryptedMedia(d)==nil{t.Fatal("arbitrary URL accepted")}
 integral.DirectPath=proto.String("//evil.test/x");if validateEncryptedMedia(d)==nil{t.Fatal("protocol-relative path accepted")}
 integral.DirectPath=proto.String("/media");integral.MediaKey=nil;if validateEncryptedMedia(d)==nil{t.Fatal("missing cryptographic key accepted")}
}
func TestMediaHostAndStreamingLimits(t *testing.T){
 for _,raw:=range []string{"http://cdn.fbsbx.com/a","https://evilfbcdn.net/a","https://facebook.com.evil.test/a","https://127.0.0.1/a","https://user:pass@cdn.fbsbx.com/a","https://cdn.fbsbx.com:8443/a"}{u,_:=url.Parse(raw);if allowedMediaURL(u){t.Fatal("unsafe host accepted",raw)}}
 u,_:=url.Parse("https://cdn.fbsbx.com/a");if !allowedMediaURL(u){t.Fatal("Meta CDN rejected")}
 body:=&limitedMediaBody{ReadCloser:io.NopCloser(bytes.NewReader(make([]byte,40))),n:12}
 data,err:=io.ReadAll(body);if err==nil||len(data)!=12{t.Fatalf("download not bounded: %d %v",len(data),err)}
}
func TestChunkedMediaIsBoundToTokenAndExpires(t *testing.T){
 data:=bytes.Repeat([]byte{7},600000);c:=&connector{downloads:map[string]mediaPayload{"token":{data:data,expires:time.Now().Add(time.Minute)}}}
 result,err:=c.mediaAction(context.Background(),"media.chunk",args{Token:"token",Offset:0});if err!=nil{t.Fatal(err)}
 row:=result.(map[string]any);chunk,_:=base64.StdEncoding.DecodeString(row["data"].(string));if len(chunk)!=256*1024||row["next"]!=256*1024||!bytes.Equal(chunk,data[:len(chunk)]){t.Fatal("bad chunk boundaries")}
 if _,err=c.mediaAction(context.Background(),"media.chunk",args{Token:"wrong",Offset:0});err==nil{t.Fatal("foreign token accepted")}
 c.mediaAction(context.Background(),"media.release",args{Token:"token"})
 if _,err=c.mediaAction(context.Background(),"media.chunk",args{Token:"token"});err==nil{t.Fatal("released token retained")}
 c.downloads["expired"]=mediaPayload{data:data,expires:time.Now().Add(-time.Minute)}
 if _,err=c.mediaAction(context.Background(),"media.chunk",args{Token:"expired"});err==nil{t.Fatal("expired token retained")}
}
func TestRegularVideoUsesPlayableSourceInsteadOfThumbnail(t *testing.T){
 w:=&table.WrappedMessage{BlobAttachments:[]*table.LSInsertBlobAttachment{{PlayableUrl:"https://cdn.fbsbx.com/movie.mp4",PlayableUrlMimeType:"video/mp4",PreviewUrl:"https://cdn.fbsbx.com/thumb.jpg",Filesize:500}}}
 d:=plainMedia(w);if d==nil||d.Kind!="video"||d.URL!="https://cdn.fbsbx.com/movie.mp4"{t.Fatal("video downgraded to thumbnail")}
}
