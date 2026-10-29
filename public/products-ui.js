export function productsUI(ctx){
 const {esc,api,show,toast,$}=ctx,read=ctx.read,money=n=>new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(n||0);
 let query='',filter='all',lastRender='';const pendingImages=new WeakMap();
 const list=()=>read().state.products||[];
 const image=p=>'/api/products/'+p.id+'/image?v='+p.image_version;
 const status=p=>!p.active?'Ngừng bán':p.stock?'Còn hàng':'Hết hàng';
 function filtered(){const q=query.trim().toLocaleLowerCase('vi');return list().filter(p=>(filter==='all'||filter==='available'&&p.active&&p.stock>0||filter==='empty'&&p.active&&!p.stock||filter==='archived'&&!p.active)&&(!q||[p.name,p.sku,p.description].join(' ').toLocaleLowerCase('vi').includes(q)));}
 const imageHTML=p=>p.has_image?`<img src="${image(p)}" alt="${esc(p.name)}" loading="lazy">`:'<span aria-hidden="true">▣</span>';
 function cards(){const rows=filtered();return rows.length?rows.map(p=>`<article class="product-card"><button class="product-cover" type="button" data-product-detail="${p.id}" aria-label="Chi tiết sản phẩm ${esc(p.name)}">${imageHTML(p)}</button><div class="product-card-body"><div class="product-card-top"><small>${esc(p.sku)}</small><span class="stock-pill ${!p.active?'archived':p.stock?'available':'empty'}">${status(p)}</span></div><h3>${esc(p.name)}</h3><p class="product-description">${esc(p.description||'Chưa có nội dung sản phẩm.')}</p><div class="product-price">${money(p.price)}</div><div class="product-card-bottom"><span>Tồn kho <strong>${p.stock.toLocaleString('vi-VN')}</strong></span>${read().user?.role==='admin'?`<button type="button" data-product-edit="${p.id}">Chỉnh sửa</button>`:`<button type="button" data-product-detail="${p.id}">Chi tiết</button>`}</div></div></article>`).join(''):`<div class="empty product-empty"><h2>${list().length?'Không tìm thấy sản phẩm':'Chưa có sản phẩm'}</h2><p>${list().length?'Thử tên, mã hoặc bộ lọc khác.':'Thêm sản phẩm và nhập tồn kho trước khi tạo đơn hàng.'}</p>${read().user?.role==='admin'?'<button class="primary" type="button" data-product-add>+ Thêm sản phẩm</button>':''}</div>`;}
 const signature=()=>JSON.stringify([list(),query,filter]);
 function productsPage(){lastRender=signature();return `<div class="page-intro"><div><h2>Sản phẩm và tồn kho</h2><p>Danh mục dùng chung cho đội ngũ. Đơn mới trừ tồn; hủy đơn hoàn tồn.</p></div>${read().user?.role==='admin'?'<button class="primary" type="button" data-product-add>+ Thêm sản phẩm</button>':''}</div><div class="product-toolbar"><label class="sr-only" for="product-search">Tìm sản phẩm</label><input id="product-search" type="search" placeholder="Tìm theo tên, mã hoặc nội dung…" value="${esc(query)}"><span id="product-count" class="muted">${filtered().length} / ${list().length} sản phẩm</span></div><div class="order-filters product-filters" role="group" aria-label="Lọc sản phẩm">${[['all','Tất cả'],['available','Còn hàng'],['empty','Hết hàng'],['archived','Ngừng bán']].map(([v,n])=>`<button type="button" data-product-filter="${v}" aria-pressed="${filter===v}" class="${filter===v?'active':''}">${n}</button>`).join('')}</div><div class="product-grid" id="product-grid">${cards()}</div>${read().user?.role!=='admin'?'<p class="help">Quản trị viên thêm sản phẩm, chỉnh đơn giá và nhập số lượng tồn kho.</p>':''}`;}
 function refreshProducts(){if(read().view!=='products'||!$('#product-grid')||lastRender===signature())return;lastRender=signature();$('#product-grid').innerHTML=cards();$('#product-count').textContent=filtered().length+' / '+list().length+' sản phẩm';for(const b of document.querySelectorAll('[data-product-filter]')){b.classList.toggle('active',b.dataset.productFilter===filter);b.setAttribute('aria-pressed',String(b.dataset.productFilter===filter));}}
 function openProduct(id){
  if(read().user?.role!=='admin')return;
  const p=id?list().find(p=>p.id===Number(id)):null;if(id&&!p){toast('Không tìm thấy sản phẩm.');return;}
  show(p?'Chỉnh sửa sản phẩm':'Thêm sản phẩm',`<form class="form product-form" data-form="product" data-product-id="${p?.id||''}" data-version="${p?.version||''}"><div class="product-editor-image"><div id="product-image-preview">${p?.has_image?imageHTML(p):'<span>Chưa có ảnh</span>'}</div><div><label class="product-image-picker" for="product-image-file">Chọn ảnh sản phẩm</label><input id="product-image-file" type="file" accept="image/jpeg,image/png,image/webp"><small class="help">JPG, PNG, WebP tối đa 10 MB; tự tối ưu trước khi lưu.</small><button type="button" class="quiet" data-product-remove-image>Gỡ ảnh</button><p class="product-image-status help" role="status"></p></div></div><label for="product-name">Tên sản phẩm</label><input id="product-name" name="name" value="${esc(p?.name||'')}" maxlength="200" required><div class="form-grid"><label>Mã sản phẩm<input name="sku" value="${esc(p?.sku||'')}" maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" placeholder="Ví dụ: AO-001 · để trống để tạo tự động"></label><label>Đơn giá (₫)<input name="price" type="number" value="${p?.price||0}" min="0" max="100000000000" step="1" required></label></div><label for="product-description">Nội dung sản phẩm</label><textarea id="product-description" name="description" rows="4" maxlength="6000" placeholder="Mô tả, chất liệu, quy cách…">${esc(p?.description||'')}</textarea><div class="form-grid"><label>Tồn kho hiện còn<input name="stock" type="number" min="0" max="1000000000" step="1" value="${p?.stock||0}" required></label><label>Trạng thái<select name="active"><option value="1" ${!p||p.active?'selected':''}>Đang bán</option><option value="0" ${p&&!p.active?'selected':''}>Ngừng bán</option></select></label></div><p class="help">Nhập số lượng hiện có thể bán. Sản phẩm hết tồn sẽ không tạo được đơn. Ảnh sản phẩm được lưu lâu dài cùng danh mục.</p><div class="actions">${p?`<button type="button" data-product-reload="${p.id}">Tải lại sản phẩm</button>`:''}<button class="primary" type="submit">Lưu sản phẩm</button></div><p class="error" role="alert"></p></form>`);
 }
 function detail(id){const p=list().find(p=>p.id===id);if(!p)return;show(p.name,`<div class="product-detail">${p.has_image?`<a href="${image(p)}" target="_blank" rel="noopener noreferrer">${imageHTML(p)}</a>`:''}<p class="muted">${esc(p.sku)} · ${status(p)}</p><strong class="product-price">${money(p.price)}</strong><p>Tồn kho: <strong>${p.stock}</strong></p><p class="product-detail-description">${esc(p.description||'Chưa có nội dung sản phẩm.')}</p></div>`);}
 async function optimizeImage(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10*1024**2)throw Error('Chọn ảnh JPG, PNG hoặc WebP tối đa 10 MB.');
  const bitmap=await createImageBitmap(file);
  try{
   if(bitmap.width*bitmap.height>25000000)throw Error('Ảnh quá lớn. Chọn ảnh dưới 25 megapixel.');
   let width=Math.min(bitmap.width,1200),height=Math.max(1,Math.round(bitmap.height*width/bitmap.width));if(height>1200){width=Math.max(1,Math.round(width*1200/height));height=1200;}
   const canvas=document.createElement('canvas');
   for(let attempt=0;attempt<5;attempt++){
    canvas.width=width;canvas.height=height;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,width,height);c.drawImage(bitmap,0,0,width,height);
    const result=canvas.toDataURL('image/jpeg',.82-attempt*.05),data=result.split(',')[1];
    if(data.length<=698000)return {mime:'image/jpeg',data,preview:result};
    width=Math.max(1,Math.round(width*.8));height=Math.max(1,Math.round(height*.8));
   }
   throw Error('Chưa tối ưu được ảnh. Chọn ảnh nhỏ hơn.');
  }finally{bitmap.close();}
 }
 async function saveProduct(f,d){
  if(f.dataset.imageBusy==='1')throw Error('Chờ tối ưu ảnh xong rồi lưu.');
  const image=pendingImages.get(f),id=f.dataset.productId;
  const body={name:d.name,sku:d.sku.trim(),description:d.description,price:Number(d.price),stock:Number(d.stock),active:d.active==='1',...(id?{version:Number(f.dataset.version)}:{}),...(image===undefined?{}:{image:image===null?null:{mime:image.mime,data:image.data}})};
  await api('/products'+(id?'/'+id:''),id?'PATCH':'POST',body);
  if(f.isConnected)ctx.modal.close();
  await ctx.reload();refreshProducts();toast('Đã lưu sản phẩm và tồn kho.');
 }
 document.addEventListener('input',e=>{if(e.target.id==='product-search'){query=e.target.value;refreshProducts();}});
 document.addEventListener('click',async e=>{
  const t=e.target.closest('button');if(!t)return;
  if(t.hasAttribute('data-product-add'))openProduct();
  if(t.dataset.productEdit)openProduct(Number(t.dataset.productEdit));
  if(t.dataset.productDetail)detail(Number(t.dataset.productDetail));
  if(t.dataset.productFilter){filter=t.dataset.productFilter;refreshProducts();}
  if(t.dataset.productReload){const id=Number(t.dataset.productReload);try{await ctx.reload();if(t.isConnected){ctx.modal.close();openProduct(id);}}catch(e){toast(e.message);}}
  if(t.hasAttribute('data-product-remove-image')){const f=t.closest('form');if(f.dataset.imageBusy==='1')return;pendingImages.set(f,null);f.querySelector('#product-image-preview').innerHTML='<span>Chưa có ảnh</span>';f.querySelector('input[type=file]').value='';}
 });
 document.addEventListener('change',async e=>{
  if(e.target.id!=='product-image-file'||!e.target.files[0])return;
  const f=e.target.closest('form'),status=f.querySelector('.product-image-status'),button=f.querySelector('[type=submit]');
  f.dataset.imageBusy='1';button.disabled=true;status.textContent='Đang tối ưu ảnh…';
  try{const img=await optimizeImage(e.target.files[0]);if(f.isConnected){pendingImages.set(f,img);f.querySelector('#product-image-preview').innerHTML=`<img src="${img.preview}" alt="Xem trước ảnh sản phẩm">`;status.textContent='Ảnh đã sẵn sàng. Bấm Lưu sản phẩm để áp dụng.';}}
  catch(err){if(f.isConnected){status.textContent=err.message;e.target.value='';}}
  finally{if(f.isConnected){f.dataset.imageBusy='0';button.disabled=false;}}
 });
 return {productsPage,refreshProducts,openProduct,saveProduct};
}
