package main
import (
 "context"
 "testing"
 "encoding/json"
)
func TestBoundaryDoesNotExposeUnknownMethodOrRequestSecrets(t *testing.T){
 c:=&connector{}
 r:=request{Method:"exec",Params:json.RawMessage(`{"Input":{"password":"private-password"}}`)}
 _,err:=c.handle(context.Background(),r)
 if err==nil||err.Error()!="UNSUPPORTED_METHOD"{t.Fatal("unexpected protocol result")}
}
func TestPeerIDValidation(t *testing.T){
 for _,id:=range []string{"","1;rm","https://example.test","../x","1@evil","１２"}{if validID(id){t.Fatal("accepted invalid identity")}}
 if !validID("1234567890123"){t.Fatal("valid identity rejected")}
}
