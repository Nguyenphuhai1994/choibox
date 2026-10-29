import {icon,presetRange,rangeControls,rangeParams} from './ui-kit.js';
export function reportsUI({api,esc,$,read,toast}){
 let range=presetRange('today'),generation=0,data=null;
 const money=n=>new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(n||0);
 function page(){return '<div class="page-intro"><div><h2>Công việc trong tầm nhìn</h2><p>Tin nhắn, hội thoại và đơn hàng từ các kênh thật được cấp quyền.</p></div><span class="pill">'+icon('calendar')+' Giờ Việt Nam (UTC+7)</span></div>'+rangeControls(range,'reports')+'<div id="report-results" aria-live="polite"></div>';}
 function content(d){
 const c=d.counts;
 const metrics=[['chat','Tổng tin nhắn',c.messages,'Nhận '+c.incoming+' · Gửi '+c.outgoing],['inbox','Hội thoại hoạt động',c.conversations,'Có tin nhắn trong kỳ'],['clock','Chờ phản hồi',c.awaiting,'Tin cuối là của khách, chưa đóng'],['info','Chưa phân công',c.unassigned,'Hội thoại chưa hoàn tất'],['orders','Đơn được tạo',c.orders,'Tổng đơn tạo trong kỳ'],['truck','Đang giao',c.shipping,'Trạng thái hiện tại'],['check','Đã giao / hoàn tất',c.completed,'Đơn đánh dấu hoàn tất'],['money','Giá trị hoàn tất',money(c.completed_total),'Theo đơn tạo trong kỳ']];
 const max=Math.max(1,...d.days.map(x=>x.incoming+x.outgoing));
 return '<div class="metrics-grid">'+metrics.map(([i,t,v,sub])=>'<article class="metric-card"><div class="metric-top"><span class="metric-icon">'+icon(i)+'</span><span>'+t+'</span></div><strong>'+v+'</strong><small>'+sub+'</small></article>').join('')+'</div><div class="report-panels"><section class="report-panel"><h3>'+icon('inbox')+' Tình trạng hội thoại</h3><p class="help">Trạng thái hiện tại của hội thoại có hoạt động trong khoảng đã chọn.</p><div class="status-metrics">'+[['Đang mở / chưa xử lý',c.open,'open'],['Đang xử lý / chờ',c.pending,'pending'],['Đã xử lý',c.closed,'closed']].map(([n,v,s])=>'<div class="'+s+'"><span>'+n+'</span><strong>'+v+'</strong></div>').join('')+'</div><p class="help">Bình luận: '+c.comments+' lượt · Ghi chú nội bộ: '+c.notes+'. Tin nhắn không tính bình luận, ghi chú và đơn nội bộ.</p></section><section class="report-panel"><h3>'+icon('orders')+' Tiến độ đơn hàng</h3><div class="order-breakdown">'+[['Mới tạo',c.new],['Xác nhận',c.confirmed],['Đang giao',c.shipping],['Hoàn tất',c.completed],['Đã huỷ',c.cancelled]].map(([n,v])=>'<div><span>'+n+'</span><strong>'+v+'</strong></div>').join('')+'</div><p class="help">Giá trị đơn chưa huỷ: <strong>'+money(c.total)+'</strong>. Đây là giá trị đơn, chưa xác nhận doanh thu thực thu.</p></section></div><section class="report-panel"><h3>'+icon('reports')+' Nhịp hội thoại theo ngày</h3><div class="activity-bars">'+d.days.map(x=>'<div class="activity-row"><span>'+x.day.slice(5).split('-').reverse().join('/')+'</span><div class="activity-track"><i style="width:'+Math.round((x.incoming+x.outgoing)/max*100)+'%"></i></div><strong>'+(x.incoming+x.outgoing)+'</strong><small>'+x.orders+' đơn</small></div>').join('')+'</div></section><section class="report-panel"><h3>'+icon('users')+' Theo người phụ trách</h3>'+(d.staff.length?'<div class="table-wrap"><table><thead><tr><th>Nhân viên</th><th>Chưa hoàn tất</th><th>Đã xử lý</th></tr></thead><tbody>'+d.staff.map(s=>'<tr><td>'+esc(s.name)+'</td><td>'+s.open+'</td><td>'+s.closed+'</td></tr>').join('')+'</tbody></table></div>':'<p class="empty-inline">Chưa có hội thoại được phân công trong kỳ.</p>')+'</section>';
 }
 async function load(){
 const gen=++generation,host=$('#report-results');if(!host)return;
 host.innerHTML='<p class="notice" role="status">Đang tổng hợp dữ liệu…</p>';
 try{const params=rangeParams(range);const next=await api('/reports?'+params);if(gen===generation&&read().view==='reports'&&host.isConnected){data=next;host.innerHTML=content(data);}}
 catch(e){if(gen===generation&&host.isConnected)host.innerHTML='<p class="error" role="alert">'+esc(e.message)+'</p><button type="button" data-report-retry>Thử lại</button>';}
 }
 document.addEventListener('click',e=>{
 const b=e.target.closest('button'),host=b?.closest('[data-period="reports"]');if(!b)return;
 if(b.hasAttribute('data-report-retry')){void load();return;}
 if(!host)return;
 if(b.dataset.periodPreset){const v=b.dataset.periodPreset;if(v==='custom'){range={...range,preset:v};host.outerHTML=rangeControls(range,'reports');return;}range=presetRange(v);host.outerHTML=rangeControls(range,'reports');void load();}
 if(b.hasAttribute('data-period-apply')){const next={preset:'custom',from:host.querySelector('[data-period-from]').value,to:host.querySelector('[data-period-to]').value};try{rangeParams(next);range=next;host.outerHTML=rangeControls(range,'reports');void load();}catch(err){toast(err.message);}}
 });
 return {page,load};
}
