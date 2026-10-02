const canvas = document.querySelector("#scene");
const gl = canvas.getContext("webgl2", { antialias: true });
const message = document.querySelector("#message");
const errorBox = document.querySelector("#error");
const fixedTypes = { point:1, bar2:2, bar3:3, tria3:3, tria6:6, quad4:4, quad8:8, tetra4:4, tetra10:10, pyramid5:5, pyramid13:13, penta6:6, penta15:15, hexa8:8, hexa20:20 };
let renderer, model, yaw=.65, pitch=.25, roll=0, zoom=1, panX=0, panY=0, drag;

const record = (view, at) => {
  let s=""; for(let i=0;i<80 && at+i<view.byteLength;i++){const c=view.getUint8(at+i);if(!c)break;s+=String.fromCharCode(c);} return s.trim();
};
function readGeometry(buffer) {
  const v=new DataView(buffer); if(!record(v,0).includes("Binary"))throw Error("Only binary EnSight Gold geometry is supported.");
  const nodeIds=record(v,240).toLowerCase().includes("given"), elementIds=record(v,320).toLowerCase().includes("given");
  let o=400; const parts=[];
  const need=n=>{if(o+n>v.byteLength)throw Error("Unexpected end of the geometry file.");};
  const i32=()=>{need(4);const n=v.getInt32(o,true);o+=4;return n;};
  const skip=n=>{need(n);o+=n;};
  const floats=n=>{need(4*n);const a=new Float32Array(n);for(let i=0;i<n;i++)a[i]=v.getFloat32(o+4*i,true);o+=4*n;return a;};
  while(o+80<=v.byteLength){let word=record(v,o).toLowerCase();o+=80;if(!word)continue;if(word!=="part")throw Error(`Expected part record; found ${word}.`);
    const id=i32(), name=record(v,o);o+=80;word=record(v,o).toLowerCase();o+=80;if(word!=="coordinates")throw Error(`Part ${name} has unsupported geometry.`);
    const nn=i32();if(nn<1||nn>10000000)throw Error(`Invalid coordinate count in ${name}.`);if(nodeIds)skip(4*nn);
    const x=floats(nn),y=floats(nn),z=floats(nn),points=new Float32Array(nn*3);for(let n=0;n<nn;n++){points[3*n]=x[n];points[3*n+1]=y[n];points[3*n+2]=z[n];}
    const p={id,name,points,blocks:[]};
    while(o+80<=v.byteLength){word=record(v,o).toLowerCase();if(word==="part")break;o+=80;if(!word)continue;
      if(word==="extents"){skip(24);continue;}if(word.includes("block"))throw Error("Structured blocks are not supported; export surface parts.");
      if(word==="nsided"){const count=i32();if(elementIds)skip(4*count);const sizes=new Uint32Array(count);let total=0;for(let c=0;c<count;c++){sizes[c]=i32();total+=sizes[c];}const conn=new Uint32Array(total);for(let n=0;n<total;n++)conn[n]=i32()-1;p.blocks.push({type:word,count,sizes,conn});continue;}
      const width=fixedTypes[word];if(!width)throw Error(`Unsupported EnSight element type ${word} in ${name}.`);const count=i32();if(count<0||count>20000000)throw Error(`Invalid cell count in ${name}.`);if(elementIds)skip(4*count);const conn=new Uint32Array(width*count);for(let n=0;n<conn.length;n++)conn[n]=i32()-1;p.blocks.push({type:word,count,width,conn});
    } parts.push(p);
  }
  if(!parts.length)throw Error("No geometry parts found.");return parts;
}
function readCp(buffer,parts){const v=new DataView(buffer);let o=80;const i32=()=>{if(o+4>v.byteLength)throw Error("PressureCoefficient file ended early.");const n=v.getInt32(o,true);o+=4;return n;};
  for(const p of parts){if(record(v,o).toLowerCase()!=="part")throw Error(`Expected Cp for part ${p.id}.`);o+=80;if(i32()!==p.id)throw Error(`Cp part does not match geometry part ${p.id}.`);
    for(const b of p.blocks){if(record(v,o).toLowerCase()!==b.type)throw Error(`Cp element group does not match ${b.type} for ${p.name}.`);o+=80;if(o+4*b.count>v.byteLength)throw Error("Not enough Cp cell values.");b.cp=new Float32Array(b.count);for(let c=0;c<b.count;c++)b.cp[c]=v.getFloat32(o+4*c,true);o+=4*b.count;}}
}
function toMesh(parts){let base=0,triangles=0,min=Infinity,max=-Infinity;const offsets=[];
  for(const p of parts){offsets.push(base);base+=p.points.length/3;
    for(const b of p.blocks){if(b.type==="tria3"||b.type==="quad4"||b.type==="nsided"){for(const cp of b.cp){if(Number.isFinite(cp)){min=Math.min(min,cp);max=Math.max(max,cp);}}}if(b.type==="tria3")triangles+=b.count;else if(b.type==="quad4")triangles+=2*b.count;else if(b.type==="nsided")for(const size of b.sizes)triangles+=Math.max(0,size-2);}}
  if(!triangles)throw Error("No tria3, quad4, or nsided surface cells with scalar values were found.");const allPos=new Float32Array(base*3),sum=new Float64Array(base),ncp=new Uint32Array(base),used=new Uint8Array(base),ix=new Uint32Array(triangles*3);let cursor=0;
  for(let k=0;k<parts.length;k++){const p=parts[k],off=offsets[k],count=p.points.length/3;allPos.set(p.points,off*3);
    for(const b of p.blocks){if(b.type!=="tria3"&&b.type!=="quad4"&&b.type!=="nsided")continue;let cellAt=0;for(let c=0;c<b.count;c++){const width=b.type==="nsided"?b.sizes[c]:b.width,at=cellAt;for(let q=0;q<width;q++){const n=off+b.conn[at+q];if(n>=off&&n<off+count&&Number.isFinite(b.cp[c])){sum[n]+=b.cp[c];ncp[n]++;}}
      const a=off+b.conn[at];if(width>=3){for(let q=1;q<width-1;q++){const bb=off+b.conn[at+q],cc=off+b.conn[at+q+1];if(a<off||bb<off||cc<off||a>=off+count||bb>=off+count||cc>=off+count)continue;ix[cursor++]=a;ix[cursor++]=bb;ix[cursor++]=cc;used[a]=used[bb]=used[cc]=1;}}
      cellAt+=width;}}
  }
  const remap=new Int32Array(base);remap.fill(-1);let usedCount=0;for(let n=0;n<base;n++)if(used[n])remap[n]=usedCount++;
  const pos=new Float32Array(usedCount*3),cp=new Float32Array(usedCount),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let n=0;n<base;n++){const target=remap[n];if(target<0)continue;const at=target*3,src=n*3;for(let a=0;a<3;a++){pos[at+a]=allPos[src+a];lo[a]=Math.min(lo[a],allPos[src+a]);hi[a]=Math.max(hi[a],allPos[src+a]);}cp[target]=ncp[n]?sum[n]/ncp[n]:NaN;}
  for(let i=0;i<cursor;i++)ix[i]=remap[ix[i]];
  const center=lo.map((x,a)=>(x+hi[a])/2);let radius=0;for(let i=0;i<pos.length;i+=3)radius=Math.max(radius,Math.hypot(pos[i]-center[0],pos[i+1]-center[1],pos[i+2]-center[2]));return{pos,cp,ix:ix.subarray(0,cursor),center,radius,min,max};
}
function makeRenderer(data){if(!gl)throw Error("WebGL2 is unavailable in this browser.");
 if(renderer){gl.bindBuffer(gl.ARRAY_BUFFER,renderer.cpBuffer);gl.bufferData(gl.ARRAY_BUFFER,data.cp,gl.STATIC_DRAW);renderer.data=data;model=data;draw();return;}
 const vs=`#version 300 es\nin vec3 p;in float val;uniform vec2 size;uniform vec3 center;uniform float radius,zoom,yaw,pitch,roll;uniform vec2 pan;out float cp;void main(){vec3 a=(p-center)/radius;float cy=cos(yaw),sy=sin(yaw),cx=cos(pitch),sx=sin(pitch);vec3 q=vec3(cy*a.x+sy*a.z,sx*sy*a.x+cx*a.y-sx*cy*a.z,-cx*sy*a.x+sx*a.y+cx*cy*a.z);float cr=cos(roll),sr=sin(roll);q=vec3(cr*q.x-sr*q.y,sr*q.x+cr*q.y,q.z);gl_Position=vec4(q.x*zoom*size.y/size.x+pan.x,q.y*zoom+pan.y,q.z*.4,1.);cp=val;}`;
 const fs=`#version 300 es\nprecision highp float;in float cp;uniform float lo,hi;out vec4 color;vec3 pal(float t){vec3 c[7]=vec3[7](vec3(.32,.2,.86),vec3(.08,.52,.98),vec3(.05,.86,.78),vec3(.19,.9,.24),vec3(1.,.9,.08),vec3(1.,.45,.06),vec3(.86,.08,.07));float x=clamp(t,0.,1.)*6.;int i=min(int(x),5);return mix(c[i],c[i+1],fract(x));}void main(){if(isnan(cp)||cp!=cp){color=vec4(.45,.45,.45,1.);return;}color=vec4(pal((cp-lo)/max(hi-lo,.00001)),1.);}`;
 const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);let cpBuffer,positionBuffer;for(const [name,array,n] of [["p",data.pos,3],["val",data.cp,1]]){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,array,gl.STATIC_DRAW);if(name==="val")cpBuffer=b;else positionBuffer=b;const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,n,gl.FLOAT,false,0,0);}const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,data.ix,gl.STATIC_DRAW);renderer={program,vao,ib,cpBuffer,positionBuffer,data};model=data;yaw=.65;pitch=.25;roll=0;zoom=1.45;panX=panY=0;document.querySelector("#view-control").hidden=false;document.querySelector("#view-preset").value="iso";document.querySelector("#auto-range").disabled=false;document.querySelector("#reset-view").disabled=false;document.querySelector("#legend").hidden=false;message.hidden=true;draw();}
function draw(){if(!renderer)return;const d=Math.min(devicePixelRatio||1,2),w=Math.max(1,canvas.clientWidth*d),h=Math.max(1,canvas.clientHeight*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);gl.clearColor(.055,.07,.09,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.useProgram(renderer.program);gl.bindVertexArray(renderer.vao);const u=n=>gl.getUniformLocation(renderer.program,n),data=model;gl.uniform2f(u("size"),w,h);gl.uniform3fv(u("center"),data.center);gl.uniform1f(u("radius"),data.radius);gl.uniform1f(u("zoom"),zoom);gl.uniform1f(u("yaw"),yaw);gl.uniform1f(u("pitch"),pitch);gl.uniform1f(u("roll"),roll);gl.uniform2f(u("pan"),panX,panY);const [lo,hi]=colorLimits();gl.uniform1f(u("lo"),lo);gl.uniform1f(u("hi"),hi);gl.drawElements(gl.TRIANGLES,data.ix.length,gl.UNSIGNED_INT,0);}
let selectedDirectory=null,geometryParts=null,caseVariables=[];
function disposeRenderer(){if(!renderer)return;gl.deleteBuffer(renderer.ib);gl.deleteBuffer(renderer.cpBuffer);gl.deleteBuffer(renderer.positionBuffer);gl.deleteVertexArray(renderer.vao);gl.deleteProgram(renderer.program);renderer=null;model=null;document.querySelector("#view-control").hidden=true;document.querySelector("#auto-range").disabled=true;document.querySelector("#reset-view").disabled=true;document.querySelector("#legend").hidden=true;}
let fieldRequest=0;
async function loadSelectedField(){const request=++fieldRequest;const variable=caseVariables.find(v=>v.name===document.querySelector("#field-select").value);if(!variable)throw Error("Select a field from the case.");message.hidden=false;message.textContent=`Reading ${variable.name} values…`;await new Promise(requestAnimationFrame);const values=await(await getDataFile(variable.file)).arrayBuffer();if(request!==fieldRequest)return;readCp(values,geometryParts);const data=toMesh(geometryParts);document.querySelector("#case-name").textContent=`${selectedDirectory.name} · ${geometryParts.map(p=>p.name).join(", ")} · ${data.ix.length.toLocaleString()} triangles`;document.querySelector("#legend-title").textContent=variable.name;makeRenderer(data);message.hidden=true;}
const viewPresets={iso:{yaw:.65,pitch:.25,roll:0},front:{yaw:Math.PI/2,pitch:0,roll:Math.PI/2},rear:{yaw:-Math.PI/2,pitch:0,roll:-Math.PI/2},"side-plus":{yaw:0,pitch:-Math.PI/2,roll:0},"side-minus":{yaw:0,pitch:Math.PI/2,roll:Math.PI},top:{yaw:Math.PI,pitch:0,roll:0},bottom:{yaw:0,pitch:0,roll:0}};
function applyViewPreset(name){const view=viewPresets[name];if(!view)return;yaw=view.yaw;pitch=view.pitch;roll=view.roll;zoom=1.45;panX=panY=0;draw();}
// Color limits in ascending order; reversed Range min/max inputs are swapped rather than collapsing the scale.
function colorLimits(){const a=Number(document.querySelector("#cp-min").value),b=Number(document.querySelector("#cp-max").value);return a<=b?[a,b]:[b,a];}
function updateRangeLegend(){const [lo,hi]=colorLimits(),reversed=Number(document.querySelector("#cp-min").value)>Number(document.querySelector("#cp-max").value);for(const id of ["#cp-min","#cp-max"]){const input=document.querySelector(id),note=reversed?"Range min is above Range max; the limits are applied swapped.":"";input.setCustomValidity(note);input.title=note;}document.querySelector("#legend-min").textContent=String(Number(lo.toFixed(3)));document.querySelector("#legend-max").textContent=String(Number(hi.toFixed(3)));draw();}
function applyAutoRange(){if(!model||!Number.isFinite(model.min)||!Number.isFinite(model.max))return;let min=model.min,max=model.max;if(min===max){const pad=Math.max(Math.abs(min)*.05,.5);min-=pad;max+=pad;}document.querySelector("#cp-min").value=min.toFixed(3);document.querySelector("#cp-max").value=max.toFixed(3);updateRangeLegend();}
function markCustomView(){const select=document.querySelector("#view-preset");let custom=select.querySelector('option[value="custom"]');if(!custom){custom=new Option("Custom","custom");select.add(custom);}select.value="custom";}
async function getDataFile(name){const handle=await selectedDirectory.getFileHandle(name.trim().replaceAll("*","0"));return handle.getFile();}
async function openFolder(){errorBox.hidden=true;if(!window.showDirectoryPicker)throw Error("Open this viewer in Chrome or Edge to select local result files.");selectedDirectory=await window.showDirectoryPicker({mode:"read"});let caseHandle;for await(const f of selectedDirectory.values())if(f.kind==="file"&&f.name.toLowerCase().endsWith(".case")){caseHandle=f;break;}if(!caseHandle)throw Error("No EnSight .case file was found in this folder.");disposeRenderer();geometryParts=null;const txt=await(await caseHandle.getFile()).text(),geo=txt.match(/^\s*model:\s*(?:\d+\s+\d+\s+)?(.+?)\s*$/im)?.[1];caseVariables=[...txt.matchAll(/^\s*scalar\s+per\s+element:\s*(?:\d+\s+\d+\s+)?(\S+)\s+(.+?)\s*$/gim)].map(m=>({name:m[1],file:m[2].trim()}));if(!geo||!caseVariables.length)throw Error("Case file must reference geometry and at least one scalar per element.");message.hidden=false;message.textContent="Reading surface geometry…";await new Promise(requestAnimationFrame);geometryParts=readGeometry(await(await getDataFile(geo)).arrayBuffer());const select=document.querySelector("#field-select");select.replaceChildren(...caseVariables.map(v=>new Option(v.name,v.name)));select.value=caseVariables[0].name;document.querySelector("#field-control").hidden=false;await loadSelectedField();}
document.querySelector("#open-folder").addEventListener("click",async()=>{try{await openFolder();}catch(e){if(e.name==="AbortError")return;message.hidden=true;errorBox.textContent=e.message||String(e);errorBox.hidden=false;}});
document.querySelector("#field-select").addEventListener("change",async()=>{try{errorBox.hidden=true;await loadSelectedField();}catch(e){message.hidden=true;errorBox.textContent=e.message||String(e);errorBox.hidden=false;}});
document.querySelector("#reset-view").addEventListener("click",()=>{document.querySelector("#view-preset").value="iso";applyViewPreset("iso");});
document.querySelector("#view-preset").addEventListener("change",event=>applyViewPreset(event.target.value));
document.querySelector("#auto-range").addEventListener("click",applyAutoRange);
for(const el of ["#cp-min","#cp-max"])document.querySelector(el).addEventListener("input",updateRangeLegend);
canvas.addEventListener("pointerdown",event=>{drag={x:event.clientX,y:event.clientY,button:event.button};canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener("pointermove",event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;if(drag.button===2){panX+=2*dx/canvas.clientWidth;panY-=2*dy/canvas.clientHeight;}else{yaw+=dx*.008;pitch=Math.max(-1.5,Math.min(1.5,pitch+dy*.008));markCustomView();}draw();});
canvas.addEventListener("pointerup",()=>drag=null);
canvas.addEventListener("pointercancel",()=>drag=null);
canvas.addEventListener("contextmenu",event=>event.preventDefault());
canvas.addEventListener("wheel",event=>{event.preventDefault();zoom=Math.max(.2,Math.min(8,zoom*Math.exp(-event.deltaY*.001)));draw();},{passive:false});
new ResizeObserver(draw).observe(canvas);
