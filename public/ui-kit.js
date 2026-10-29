const paths={
 inbox:'M4 4h16v16H4z M4 14h5l2 3h2l2-3h5',reports:'M4 20V10m5 10V4m6 16v-7m5 7V7',products:'m3 7 9-4 9 4v10l-9 4-9-4Z M3 7l9 4 9-4m-9 4v10M7.5 5l9 4',
 orders:'M7 3h10v3h4v15H3V6h4z M7 3v5h10V3 M7 12h10m-10 4h7',channels:'M8 8V4h8v4 M4 15v5h5v-5z m11 0v5h5v-5z M12 8v4M6 15v-3h12v3',users:'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M16 3a4 4 0 0 1 0 8 M22 21v-3a4 4 0 0 0-3-3 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 replies:'M4 4h16v13H9l-5 4z M8 8h8m-8 4h5',audit:'M8 3h8v3H8z M8 5H4v16h16V5h-4 M8 11h8m-8 5h6',access:'M3 3h18v7H3z M3 14h18v7H3z M7 6h.01M7 17h.01',
 clip:'m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9 M7 14l8-8',chat:'M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z M7 10h10m-10 4h6',comment:'M4 4h16v13H9l-5 4z M8 8h8m-8 4h5',
 search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',filter:'M3 4h18l-7 8v7l-4 2v-9Z',refresh:'M20 7a8 8 0 1 0 1 8 M20 2v6h-6',info:'M12 10v7m0-10h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',check:'m5 12 4 4L19 6',clock:'M12 7v5l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',upload:'M12 17V5m-5 5 5-5 5 5M4 17v4h16v-4',calendar:'M4 5h16v16H4z M8 2v6m8-6v6M4 10h16',menu:'M4 6h16M4 12h16M4 18h16',back:'m14 5-7 7 7 7',tag:'M3 3h8l10 10-8 8L3 11z M7 7h.01',send:'m3 3 19 9-19 9 4-9-4-9Zm4 9h15',plus:'M12 4v16M4 12h16',box:'m3 7 9-4 9 4v10l-9 4-9-4Z M3 7l9 4 9-4m-9 4v10',money:'M3 5h18v14H3z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',truck:'M2 5h12v12H2z M14 9h4l4 4v4h-8 M8 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0m12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0'};
export const icon=name=>'<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.box)+'"/></svg>';
export function dayVN(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
export function presetRange(preset,now=new Date()){
 const d=dayVN(now),a=new Date(d+'T00:00:00Z');let from=d;
 if(preset==='week'){a.setUTCDate(a.getUTCDate()-(a.getUTCDay()+6)%7);from=a.toISOString().slice(0,10);}
 if(preset==='month')from=d.slice(0,8)+'01';
 if(preset==='yesterday'){a.setUTCDate(a.getUTCDate()-1);return {preset,from:a.toISOString().slice(0,10),to:a.toISOString().slice(0,10)};}
 return {preset,from,to:d};
}
export function rangeControls(range,prefix){
 return '<div class="period-control" data-period="'+prefix+'"><div class="period-presets" role="group" aria-label="Khoảng thời gian">'+[['today','Hôm nay'],['yesterday','Hôm qua'],['week','Tuần này'],['month','Tháng này'],['custom','Tuỳ chọn']].map(([v,n])=>'<button type="button" data-period-preset="'+v+'" aria-pressed="'+(range.preset===v)+'" class="'+(range.preset===v?'active':'')+'">'+n+'</button>').join('')+'</div><div class="period-dates"><label>Từ ngày<input type="date" data-period-from value="'+range.from+'" required></label><span aria-hidden="true">—</span><label>Đến ngày<input type="date" data-period-to value="'+range.to+'" required></label><button type="button" data-period-apply>'+icon('filter')+' Áp dụng</button></div></div>';
}
export function rangeParams(range){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(range.from)||!/^\d{4}-\d{2}-\d{2}$/.test(range.to)||range.from>range.to||Date.parse(range.to)-Date.parse(range.from)>365*86400000)throw Error('Chọn khoảng thời gian hợp lệ, tối đa 366 ngày.');
 return new URLSearchParams({from:range.from,to:range.to});
}
export function inRange(iso,range){const ms=Date.parse(iso);return ms>=Date.parse(range.from+'T00:00:00+07:00')&&ms<Date.parse(range.to+'T00:00:00+07:00')+86400000;}
export async function downloadFile(url,{method='GET',body,csrf}={}){
 const r=await fetch('/api'+url,{method,headers:{...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 if(!r.ok){const e=await r.json().catch(()=>({}));throw Error(e.error||'Không xuất được file.');}
 const blob=await r.blob(),a=document.createElement('a'),objectURL=URL.createObjectURL(blob);a.href=objectURL;a.download=r.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||'Choibox.xlsx';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(objectURL),60000);
}
