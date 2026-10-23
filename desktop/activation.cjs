function parseActivation(text){
 if(typeof text!=='string'||text.length>4096)throw Error('Tệp kích hoạt không hợp lệ.');
 let c;try{c=JSON.parse(text);}catch{throw Error('Tệp kích hoạt không hợp lệ.');}
 if(c.url!=='https://connect.choiagency.top'||!/^[a-f0-9]{48}$/.test(c.token)||!/^[a-f0-9]{48}$/.test(c.workspace))throw Error('Tệp kích hoạt không phải do dịch vụ Choibox cấp.');
 return {url:c.url,token:c.token,workspace:c.workspace};
}
module.exports={parseActivation};
