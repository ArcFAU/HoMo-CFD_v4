const canvas = document.querySelector("#scene");
const gl = canvas.getContext("webgl2", { antialias: true });
const message = document.querySelector("#message");
const errorBox = document.querySelector("#error");
const fixedTypes = { point:1, bar2:2, bar3:3, tria3:3, tria6:6, quad4:4, quad8:8, tetra4:4, tetra10:10, pyramid5:5, pyramid13:13, penta6:6, penta15:15, hexa8:8, hexa20:20 };
let renderer, model, azimuth=Math.PI/4, elevation=.44, zoom=1, panX=0, panY=0, drag, animation, shading=true;

// Camera: a turntable around the vehicle's vertical axis, in STAR-CCM+ coordinates
// (nose at +X, +Y = the car's left side, +Z up). Azimuth turns around Z (0 = looking
// at the nose), elevation tilts the view up or down (±90°), so the car never tips over.
function viewBasis(az=azimuth, el=elevation){
  const ca=Math.cos(az), sa=Math.sin(az), ce=Math.cos(el), se=Math.sin(el);
  const back=[ce*ca, ce*sa, se];            // from the model towards the viewer
  const right=[-sa, ca, 0];
  const up=[back[1]*right[2]-back[2]*right[1], back[2]*right[0]-back[0]*right[2], back[0]*right[1]-back[1]*right[0]];
  return {right, up, back};
}

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
    const nn=i32();if(nn<0||nn>10000000)throw Error(`Invalid coordinate count in ${name}.`);if(nodeIds)skip(4*nn);
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
// Per-element values by part id. EnSight lets a field file leave parts (or element groups) out,
// e.g. STAR-CCM+ for small wall pieces split off at interfaces: those cells stay NaN and show grey.
function readCp(buffer,parts){const v=new DataView(buffer);let o=80;const i32=()=>{if(o+4>v.byteLength)throw Error("The field file ended early.");const n=v.getInt32(o,true);o+=4;return n;};
  const byId=new Map(parts.map(p=>[p.id,p]));for(const p of parts)for(const b of p.blocks)b.cp=null;
  while(o+80<=v.byteLength){const word=record(v,o).toLowerCase();o+=80;if(!word)continue;if(word!=="part")throw Error(`Expected a part record in the field file; found ${word}.`);
    const id=i32(),p=byId.get(id);if(!p)throw Error(`The field file has values for part ${id}, which is not in the geometry.`);
    while(o+80<=v.byteLength){const type=record(v,o).toLowerCase();if(type==="part")break;o+=80;const b=p.blocks.find(block=>block.type===type&&!block.cp);if(!b)throw Error(`Field values for ${type} cells do not match part ${p.name}.`);
      if(o+4*b.count>v.byteLength)throw Error("Not enough cell values in the field file.");b.cp=new Float32Array(b.count);for(let c=0;c<b.count;c++)b.cp[c]=v.getFloat32(o+4*c,true);o+=4*b.count;}}
  for(const p of parts)for(const b of p.blocks)if(!b.cp)b.cp=new Float32Array(b.count).fill(NaN);
}
function toMesh(parts){let base=0,triangles=0,min=Infinity,max=-Infinity;const offsets=[],ranges=[];
  for(const p of parts){offsets.push(base);base+=p.points.length/3;const counted=!flowPart(p.name)?.diagnostic;
    for(const b of p.blocks){if(counted&&(b.type==="tria3"||b.type==="quad4"||b.type==="nsided")){for(const cp of b.cp){if(Number.isFinite(cp)){min=Math.min(min,cp);max=Math.max(max,cp);}}}if(b.type==="tria3")triangles+=b.count;else if(b.type==="quad4")triangles+=2*b.count;else if(b.type==="nsided")for(const size of b.sizes)triangles+=Math.max(0,size-2);}}
  if(!triangles)throw Error("No tria3, quad4, or nsided surface cells with scalar values were found.");const allPos=new Float32Array(base*3),sum=new Float64Array(base),ncp=new Uint32Array(base),used=new Uint8Array(base),ix=new Uint32Array(triangles*3);let cursor=0;
  for(let k=0;k<parts.length;k++){const p=parts[k],off=offsets[k],count=p.points.length/3,first=cursor;allPos.set(p.points,off*3);
    for(const b of p.blocks){if(b.type!=="tria3"&&b.type!=="quad4"&&b.type!=="nsided")continue;let cellAt=0;for(let c=0;c<b.count;c++){const width=b.type==="nsided"?b.sizes[c]:b.width,at=cellAt;for(let q=0;q<width;q++){const n=off+b.conn[at+q];if(n>=off&&n<off+count&&Number.isFinite(b.cp[c])){sum[n]+=b.cp[c];ncp[n]++;}}
      const a=off+b.conn[at];if(width>=3){for(let q=1;q<width-1;q++){const bb=off+b.conn[at+q],cc=off+b.conn[at+q+1];if(a<off||bb<off||cc<off||a>=off+count||bb>=off+count||cc>=off+count)continue;ix[cursor++]=a;ix[cursor++]=bb;ix[cursor++]=cc;used[a]=used[bb]=used[cc]=1;}}
      cellAt+=width;}}
    ranges.push({name:p.name,start:first,count:cursor-first});
  }
  const remap=new Int32Array(base);remap.fill(-1);let usedCount=0;for(let n=0;n<base;n++)if(used[n])remap[n]=usedCount++;
  const pos=new Float32Array(usedCount*3),cp=new Float32Array(usedCount),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(let n=0;n<base;n++){const target=remap[n];if(target<0)continue;const at=target*3,src=n*3;for(let a=0;a<3;a++){pos[at+a]=allPos[src+a];lo[a]=Math.min(lo[a],allPos[src+a]);hi[a]=Math.max(hi[a],allPos[src+a]);}cp[target]=ncp[n]?sum[n]/ncp[n]:NaN;}
  for(let i=0;i<cursor;i++)ix[i]=remap[ix[i]];
  const center=lo.map((x,a)=>(x+hi[a])/2);let radius=0;for(let i=0;i<pos.length;i+=3)radius=Math.max(radius,Math.hypot(pos[i]-center[0],pos[i+1]-center[1],pos[i+2]-center[2]));const normal=new Float32Array(pos.length);for(let t=0;t<cursor;t+=3){const a=3*ix[t],b=3*ix[t+1],c=3*ix[t+2];const ux=pos[b]-pos[a],uy=pos[b+1]-pos[a+1],uz=pos[b+2]-pos[a+2],vx=pos[c]-pos[a],vy=pos[c+1]-pos[a+1],vz=pos[c+2]-pos[a+2];const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;for(const k of [a,b,c]){normal[k]+=nx;normal[k+1]+=ny;normal[k+2]+=nz;}}return{pos,cp,normal,ix:ix.subarray(0,cursor),ranges,center,radius,min,max,lo,hi};
}
function makeRenderer(data){if(!gl)throw Error("WebGL2 is unavailable in this browser.");
 if(renderer){gl.bindBuffer(gl.ARRAY_BUFFER,renderer.cpBuffer);gl.bufferData(gl.ARRAY_BUFFER,data.cp,gl.STATIC_DRAW);renderer.data=data;model=data;draw();return;}
 // Screen x/y follow the view basis; nearer points (larger "back") get the smaller depth, so the image is a true, unmirrored view.
 const vs=`#version 300 es\nin vec3 p;in vec3 n;in float val;uniform vec2 size;uniform vec3 center,right,up,back;uniform float radius,zoom,shading;uniform vec2 pan;out float cp;out float light;void main(){vec3 a=(p-center)/radius;vec3 q=vec3(dot(a,right),dot(a,up),dot(a,back));gl_Position=vec4(q.x*zoom*size.y/size.x+pan.x,q.y*zoom+pan.y,-q.z*.4,1.);cp=val;light=mix(1.,.55+.45*abs(dot(normalize(n+vec3(1e-9)),back)),shading);}`;
 const fs=`#version 300 es\nprecision highp float;in float cp;in float light;uniform float lo,hi;out vec4 color;vec3 pal(float t){vec3 c[7]=vec3[7](vec3(.32,.2,.86),vec3(.08,.52,.98),vec3(.05,.86,.78),vec3(.19,.9,.24),vec3(1.,.9,.08),vec3(1.,.45,.06),vec3(.86,.08,.07));float x=clamp(t,0.,1.)*6.;int i=min(int(x),5);return mix(c[i],c[i+1],fract(x));}void main(){if(isnan(cp)||cp!=cp){color=vec4(vec3(.45)*light,1.);return;}color=vec4(pal((cp-lo)/max(hi-lo,.00001))*light,1.);}`;
 const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
 const vao=gl.createVertexArray();gl.bindVertexArray(vao);let cpBuffer,positionBuffer,normalBuffer;for(const [name,array,n] of [["p",data.pos,3],["n",data.normal,3],["val",data.cp,1]]){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,array,gl.STATIC_DRAW);if(name==="val")cpBuffer=b;else if(name==="n")normalBuffer=b;else positionBuffer=b;const loc=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,n,gl.FLOAT,false,0,0);}const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,data.ix,gl.STATIC_DRAW);renderer={program,vao,ib,cpBuffer,positionBuffer,normalBuffer,data};model=data;setView(DEFAULT_VIEW,false);document.querySelector("#view-control").hidden=false;document.querySelector("#axes").hidden=false;document.querySelector("#auto-range").disabled=false;document.querySelector("#reset-view").disabled=false;document.querySelector("#legend").hidden=false;message.hidden=true;draw();}
function draw(){if(!renderer)return;const d=Math.min(devicePixelRatio||1,2),w=Math.max(1,canvas.clientWidth*d),h=Math.max(1,canvas.clientHeight*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}gl.viewport(0,0,w,h);gl.clearColor(.055,.07,.09,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.useProgram(renderer.program);gl.bindVertexArray(renderer.vao);const u=n=>gl.getUniformLocation(renderer.program,n),data=model;gl.uniform2f(u("size"),w,h);gl.uniform3fv(u("center"),data.center);gl.uniform1f(u("radius"),data.radius);gl.uniform1f(u("zoom"),zoom);const view=viewBasis();gl.uniform3fv(u("right"),view.right);gl.uniform3fv(u("up"),view.up);gl.uniform3fv(u("back"),view.back);gl.uniform1f(u("shading"),shading?1:0);gl.uniform2f(u("pan"),panX,panY);const [lo,hi]=colorLimits();gl.uniform1f(u("lo"),lo);gl.uniform1f(u("hi"),hi);for(const range of data.ranges)if(range.count&&!hiddenParts.has(range.name))gl.drawElements(gl.TRIANGLES,range.count,gl.UNSIGNED_INT,range.start*4);drawAxes(view);}
// A 3D-data folder can hold several EnSight cases (export3D.java writes the car and, separately, the
// flow parts); they are shown as one model. caseSets: [{parts, files: Map(field name -> file)}].
let selectedDirectory=null,geometryParts=null,caseVariables=[],caseSets=[];
function disposeRenderer(){if(!renderer)return;gl.deleteBuffer(renderer.ib);gl.deleteBuffer(renderer.cpBuffer);gl.deleteBuffer(renderer.positionBuffer);gl.deleteBuffer(renderer.normalBuffer);gl.deleteVertexArray(renderer.vao);gl.deleteProgram(renderer.program);renderer=null;model=null;document.querySelector("#view-control").hidden=true;document.querySelector("#axes").hidden=true;document.querySelector("#auto-range").disabled=true;document.querySelector("#reset-view").disabled=true;document.querySelector("#legend").hidden=true;}
let fieldRequest=0;
async function loadSelectedField(){const request=++fieldRequest;const variable=caseVariables.find(v=>v.name===document.querySelector("#field-select").value);if(!variable)throw Error("Select a field from the case.");message.hidden=false;message.textContent=`Reading ${variable.name} values…`;await new Promise(requestAnimationFrame);const buffers=await Promise.all(caseSets.map(async set=>set.files.has(variable.name)?(await getDataFile(set.files.get(variable.name))).arrayBuffer():null));if(request!==fieldRequest)return;caseSets.forEach((set,index)=>{if(buffers[index])readCp(buffers[index],set.parts);else for(const p of set.parts)for(const b of p.blocks)b.cp=new Float32Array(b.count).fill(NaN);});const data=toMesh(geometryParts);document.querySelector("#case-name").textContent=`${selectedDirectory.name} · ${geometryParts.filter(p=>p.points.length).map(p=>p.name).join(", ")} · ${(data.ix.length / 3).toLocaleString()} triangles`;document.querySelector("#legend-title").textContent=variable.name;currentField=variable.name;makeRenderer(data);applyFieldRange();message.hidden=true;}
// Views by name: [azimuth, elevation] in degrees. Top and bottom keep the nose pointing up on screen.
const viewPresets={"front-left":[45,25],"front-right":[-45,25],"rear-left":[135,25],"rear-right":[-135,25],front:[0,0],rear:[180,0],left:[90,0],right:[-90,0],top:[180,90],bottom:[0,-90]};
const DEFAULT_VIEW="front-left";
const deg=Math.PI/180;
const clampElevation=el=>Math.max(-Math.PI/2,Math.min(Math.PI/2,el));
// Moves the camera to a named view (resets zoom and position), animated unless the user prefers less motion.
function setView(name,animate=true){const view=viewPresets[name];if(!view)return;document.querySelector("#view-preset").value=name;const az=view[0]*deg,el=view[1]*deg,fit=fitView(az,el);moveCamera(az,el,fit.zoom,fit.panX,fit.panY,animate);}
// Zoom and position that fit the model's bounding box in the window for a view, leaving room for the legend below.
function fitView(az,el){if(!model)return{zoom:1.45,panX:0,panY:0};const view=viewBasis(az,el),aspect=(canvas.clientHeight||1)/(canvas.clientWidth||1);let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;for(let i=0;i<8;i++){const a=[0,1,2].map(k=>(((i>>k)&1?model.hi[k]:model.lo[k])-model.center[k])/model.radius);const x=a[0]*view.right[0]+a[1]*view.right[1]+a[2]*view.right[2],y=a[0]*view.up[0]+a[1]*view.up[1]+a[2]*view.up[2];x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}const zoom=Math.min(1.8/Math.max((x1-x0)*aspect,1e-6),1.55/Math.max(y1-y0,1e-6),40);return{zoom,panX:-(x0+x1)/2*zoom*aspect,panY:.125-(y0+y1)/2*zoom};}
function moveCamera(az,el,toZoom,toPanX,toPanY,animate=true){cancelAnimationFrame(animation);animation=0;
  const turn=((az-azimuth)%(2*Math.PI)+3*Math.PI)%(2*Math.PI)-Math.PI;  // shortest way round
  const from={az:azimuth,el:elevation,zoom,panX,panY},to={az:azimuth+turn,el,zoom:toZoom,panX:toPanX,panY:toPanY};
  const still=!animate||!renderer||matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start=performance.now(),step=now=>{const t=still?1:Math.min(1,(now-start)/320),e=t*t*(3-2*t);
    azimuth=from.az+(to.az-from.az)*e;elevation=from.el+(to.el-from.el)*e;zoom=from.zoom+(to.zoom-from.zoom)*e;panX=from.panX+(to.panX-from.panX)*e;panY=from.panY+(to.panY-from.panY)*e;draw();
    animation=t<1?requestAnimationFrame(step):0;};
  step(start);}
function applyViewPreset(name){const view=viewPresets[name];if(!view)return;yaw=view.yaw;pitch=view.pitch;roll=view.roll;zoom=1.45;panX=panY=0;draw();}
// Parts that are not the car: shown or hidden with their own checkbox.
const FLOW_PARTS=[{test:/^(lambda2|vortices)$/i,label:"Vortices (λ2)",title:"Vortex cores: iso-surface of neg(Lambda2), coloured by the selected field",on:true},
  {test:/^bad[ _]?cells$/i,label:"Bad cells",title:"Iso-surface around cells the mesh check marks as bad",on:false,diagnostic:true}];
const flowPart=name=>FLOW_PARTS.find(f=>f.test.test(String(name).trim()));
let hiddenParts=new Set(),currentField=null;
function showPartToggles(parts){const box=document.querySelector("#part-toggles");box.replaceChildren();hiddenParts=new Set();
  for(const p of parts){const kind=flowPart(p.name);if(!kind||!p.points.length)continue;if(!kind.on)hiddenParts.add(p.name);
    const label=document.createElement("label");label.title=kind.title;const input=Object.assign(document.createElement("input"),{type:"checkbox",checked:kind.on});input.dataset.part=p.name;
    input.addEventListener("change",()=>{if(input.checked)hiddenParts.delete(p.name);else hiddenParts.add(p.name);draw();});label.append(input,` ${kind.label}`);box.append(label);}
  box.hidden=!box.children.length;}
// Colour range per field: a range set by hand (or Auto range) is remembered for that field, so cases
// compare like for like; otherwise Cp fields start at -5…1 and other fields at their 1st–99th percentile.
const RANGE_KEY="homo-cfd-3d-ranges-v1";
function savedRanges(){try{return JSON.parse(localStorage.getItem(RANGE_KEY)||"{}")||{};}catch{return {};}}
function rememberFieldRange(){if(!currentField)return;const min=Number(document.querySelector("#cp-min").value),max=Number(document.querySelector("#cp-max").value);if(!Number.isFinite(min)||!Number.isFinite(max))return;
  const ranges=savedRanges();ranges[currentField]=[min,max];try{localStorage.setItem(RANGE_KEY,JSON.stringify(ranges));}catch{}}
const cpLike=name=>/^cp|pressurecoefficient/i.test(String(name).replace(/[^a-z0-9]/gi,""));
function percentileRange(values){const sample=[];const step=Math.max(1,Math.floor(values.length/200000));for(let i=0;i<values.length;i+=step)if(Number.isFinite(values[i]))sample.push(values[i]);
  if(!sample.length)return null;sample.sort((a,b)=>a-b);const at=q=>sample[Math.min(sample.length-1,Math.floor(q*(sample.length-1)))];let lo=at(.01),hi=at(.99);
  if(lo===hi){const pad=Math.max(Math.abs(lo)*.05,1e-6);lo-=pad;hi+=pad;}return [lo,hi];}
const niceNumber=x=>Number(x.toPrecision(3));
function applyFieldRange(){const saved=savedRanges()[currentField];const range=saved||(cpLike(currentField)?[-5,1]:percentileRange(model?.cp??[]));if(!range)return;
  document.querySelector("#cp-min").value=String(niceNumber(range[0]));document.querySelector("#cp-max").value=String(niceNumber(range[1]));updateRangeLegend(false);}
// Color limits in ascending order; reversed Range min/max inputs are swapped rather than collapsing the scale.
function colorLimits(){const a=Number(document.querySelector("#cp-min").value),b=Number(document.querySelector("#cp-max").value);return a<=b?[a,b]:[b,a];}
function updateRangeLegend(remember=true){if(remember)rememberFieldRange();const [lo,hi]=colorLimits(),reversed=Number(document.querySelector("#cp-min").value)>Number(document.querySelector("#cp-max").value);for(const id of ["#cp-min","#cp-max"]){const input=document.querySelector(id),note=reversed?"Range min is above Range max; the limits are applied swapped.":"";input.setCustomValidity(note);input.title=note;}document.querySelector("#legend-min").textContent=String(Number(lo.toFixed(3)));document.querySelector("#legend-max").textContent=String(Number(hi.toFixed(3)));draw();}
function applyAutoRange(){if(!model||!Number.isFinite(model.min)||!Number.isFinite(model.max))return;let min=model.min,max=model.max;if(min===max){const pad=Math.max(Math.abs(min)*.05,.5);min-=pad;max+=pad;}document.querySelector("#cp-min").value=min.toFixed(3);document.querySelector("#cp-max").value=max.toFixed(3);updateRangeLegend();}
function markCustomView(){cancelAnimationFrame(animation);animation=0;const select=document.querySelector("#view-preset");let custom=select.querySelector('option[value="custom"]');if(!custom){custom=new Option("Custom","custom");select.add(custom);}select.value="custom";}
// Orientation widget: the X/Y/Z axes as seen from the camera. Clicking an axis end looks along that axis.
const axesCanvas=document.querySelector("#axes");
const AXES=[{label:"X",color:"#ff6b6b",dir:[1,0,0],plus:"front",minus:"rear"},{label:"Y",color:"#5ee07a",dir:[0,1,0],plus:"left",minus:"right"},{label:"Z",color:"#58a6ff",dir:[0,0,1],plus:"top",minus:"bottom"}];
function axisHandles(view=viewBasis()){const size=axesCanvas.clientWidth||110,c=size/2,len=size*.34;const handles=[];
  for(const axis of AXES)for(const sign of [1,-1]){const d=axis.dir.map(x=>x*sign);const dot=v=>d[0]*v[0]+d[1]*v[1]+d[2]*v[2];
    handles.push({axis,sign,view:sign>0?axis.plus:axis.minus,x:c+dot(view.right)*len,y:c-dot(view.up)*len,depth:dot(view.back)});}
  return handles.sort((a,b)=>a.depth-b.depth);}
function drawAxes(view){if(axesCanvas.hidden)return;const ratio=Math.min(devicePixelRatio||1,2),size=axesCanvas.clientWidth||110;
  if(axesCanvas.width!==Math.round(size*ratio)){axesCanvas.width=axesCanvas.height=Math.round(size*ratio);}
  const g=axesCanvas.getContext("2d");g.setTransform(ratio,0,0,ratio,0,0);g.clearRect(0,0,size,size);const c=size/2;
  for(const h of axisHandles(view)){const faded=h.depth<-.2;g.globalAlpha=faded?.55:1;
    if(h.sign>0){g.strokeStyle=h.axis.color;g.lineWidth=2.5;g.beginPath();g.moveTo(c,c);g.lineTo(h.x,h.y);g.stroke();
      g.fillStyle=h.axis.color;g.beginPath();g.arc(h.x,h.y,9,0,2*Math.PI);g.fill();g.fillStyle="#0b1016";g.font="bold 11px system-ui,sans-serif";g.textAlign="center";g.textBaseline="middle";g.fillText(h.axis.label,h.x,h.y+.5);}
    else{g.strokeStyle=h.axis.color;g.lineWidth=1.5;g.fillStyle="#0b1016";g.beginPath();g.arc(h.x,h.y,6,0,2*Math.PI);g.fill();g.stroke();}}
  g.globalAlpha=1;}
function axisAt(x,y){let best=null,bestDistance=13;for(const h of axisHandles()){const distance=Math.hypot(h.x-x,h.y-y);if(distance<=bestDistance||(best&&distance===bestDistance&&h.depth>best.depth)){best=h;bestDistance=distance;}}return best;}
async function getDataFile(name){const handle=await selectedDirectory.getFileHandle(name.trim().replaceAll("*","0"));return handle.getFile();}
async function chooseFolder(){if(!window.showDirectoryPicker)throw Error("This browser cannot open a local folder. Open the 3D-data folder from the results tree, or use Chrome or Edge.");await openFolder(await window.showDirectoryPicker({mode:"read"}));}
async function openFolder(directory){errorBox.hidden=true;selectedDirectory=directory;const caseHandles=[];for await(const f of selectedDirectory.values())if(f.kind==="file"&&f.name.toLowerCase().endsWith(".case"))caseHandles.push(f);if(!caseHandles.length)throw Error("No EnSight .case file was found in this folder.");caseHandles.sort((a,b)=>/_flow\.case$/i.test(a.name)-/_flow\.case$/i.test(b.name)||a.name.localeCompare(b.name));disposeRenderer();geometryParts=null;caseSets=[];const names=[];message.hidden=false;message.textContent="Reading surface geometry…";await new Promise(requestAnimationFrame);for(const caseHandle of caseHandles){const txt=await(await caseHandle.getFile()).text(),geo=txt.match(/^\s*model:\s*(?:\d+\s+\d+\s+)?(.+?)\s*$/im)?.[1];const variables=[...txt.matchAll(/^\s*scalar\s+per\s+element:\s*(?:\d+\s+\d+\s+)?(.+?)\s+(\S+)\s*$/gim)].map(m=>({name:m[1].trim(),file:m[2]}));if(!geo||!variables.length)continue;caseSets.push({parts:readGeometry(await(await getDataFile(geo)).arrayBuffer()),files:new Map(variables.map(v=>[v.name,v.file]))});for(const v of variables)if(!names.includes(v.name))names.push(v.name);}if(!caseSets.length)throw Error("Case file must reference geometry and at least one scalar per element.");geometryParts=caseSets.flatMap(set=>set.parts);caseVariables=names.map(name=>({name}));showPartToggles(geometryParts);const select=document.querySelector("#field-select");select.replaceChildren(...caseVariables.map(v=>new Option(v.name,v.name)));select.value=caseVariables[0].name;document.querySelector("#field-control").hidden=false;await loadSelectedField();}
function showViewerError(e){if(e?.name==="AbortError")return;message.hidden=true;errorBox.textContent=e?.message||String(e);errorBox.hidden=false;}
document.querySelector("#open-folder").addEventListener("click",()=>chooseFolder().catch(showViewerError));
// Opened from a 3D-data entry in the results tree: the folder handle is handed over through IndexedDB.
async function openFolderFromKey(key){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("homo-cfd-settings",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const handle=await new Promise((resolve,reject)=>{const r=db.transaction("folders","readonly").objectStore("folders").get(`viewer:${key}`);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();if(!handle)throw Error("This 3D-data folder is no longer available. Reopen it from the results tree.");const directory=reviveHandle(handle);if(await directory.queryPermission({mode:"read"})!=="granted")throw Error("Folder access needs to be confirmed again. Use Open 3D-data folder.");await openFolder(directory);}
const folderKey=new URLSearchParams(location.search).get("folder");if(folderKey)openFolderFromKey(folderKey).catch(showViewerError);
document.querySelector("#field-select").addEventListener("change",async()=>{try{errorBox.hidden=true;await loadSelectedField();}catch(e){message.hidden=true;errorBox.textContent=e.message||String(e);errorBox.hidden=false;}});
document.querySelector("#reset-view").addEventListener("click",()=>setView(DEFAULT_VIEW));
document.querySelector("#view-preset").addEventListener("change",event=>setView(event.target.value));
document.querySelector("#shading").addEventListener("change",event=>{shading=event.target.checked;draw();});
const AXIS_NAMES={front:"Front (from +X)",rear:"Rear (from −X)",left:"Left side (from +Y)",right:"Right side (from −Y)",top:"Top (from +Z)",bottom:"Bottom (from −Z)"};
axesCanvas.addEventListener("click",event=>{const rect=axesCanvas.getBoundingClientRect(),h=axisAt(event.clientX-rect.left,event.clientY-rect.top);if(h)setView(h.view);});
axesCanvas.addEventListener("pointermove",event=>{const rect=axesCanvas.getBoundingClientRect(),h=axisAt(event.clientX-rect.left,event.clientY-rect.top);axesCanvas.style.cursor=h?"pointer":"default";axesCanvas.title=h?`Look from ${AXIS_NAMES[h.view]}`:"Click an axis to look along it";});
document.querySelector("#auto-range").addEventListener("click",applyAutoRange);
for(const el of ["#cp-min","#cp-max"])document.querySelector(el).addEventListener("input",updateRangeLegend);
canvas.addEventListener("pointerdown",event=>{drag={x:event.clientX,y:event.clientY,move:event.button===1||event.button===2||event.shiftKey};try{canvas.setPointerCapture(event.pointerId);}catch{}canvas.focus({preventScroll:true});});
canvas.addEventListener("pointermove",event=>{if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;if(drag.move){cancelAnimationFrame(animation);animation=0;panX+=2*dx/canvas.clientWidth;panY-=2*dy/canvas.clientHeight;}else{markCustomView();azimuth-=dx*.008;elevation=clampElevation(elevation+dy*.008);}draw();});
canvas.addEventListener("pointerup",()=>drag=null);
canvas.addEventListener("pointercancel",()=>drag=null);
canvas.addEventListener("contextmenu",event=>event.preventDefault());
canvas.addEventListener("wheel",event=>{event.preventDefault();cancelAnimationFrame(animation);animation=0;const rect=canvas.getBoundingClientRect(),cx=2*(event.clientX-rect.left)/rect.width-1,cy=1-2*(event.clientY-rect.top)/rect.height;
  const next=Math.max(.2,Math.min(40,zoom*Math.exp(-event.deltaY*.001))),k=next/zoom;panX=cx-(cx-panX)*k;panY=cy-(cy-panY)*k;zoom=next;draw();},{passive:false});
// Arrow keys: like dragging, in 15° steps. Home: back to the default view.
canvas.addEventListener("keydown",event=>{if(!renderer)return;const keys={ArrowLeft:[1,0],ArrowRight:[-1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
  if(event.key==="Home"){event.preventDefault();setView(DEFAULT_VIEW);return;}const step=keys[event.key];if(!step)return;event.preventDefault();
  markCustomView();moveCamera(azimuth+step[0]*15*deg,clampElevation(elevation+step[1]*15*deg),zoom,panX,panY);});
new ResizeObserver(draw).observe(canvas);
