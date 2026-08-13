/* Sedra Electric — lead capture (Cloudflare Pages Function)
   Route: POST /api/lead   Body: { name, phone, city, service, message, lang }
   Saves the lead into the Firebase Realtime Database used by the Sedra CRM.
   NOTE: set DB_URL / NODE below to match your CRM, and allow writes to that
   node in your Firebase rules (see setup notes). */

const DB_URL = "https://sedra-crm-default-rtdb.firebaseio.com";
const NODE   = "leads"; // change to the node your CRM reads leads from

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}
const clip=(v,n)=>(v==null?'':String(v)).trim().slice(0,n);

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request } = context;
  try{
    const b = await request.json().catch(()=>({}));
    const phone = clip(b.phone,30);
    if(phone.replace(/\D/g,'').length < 7){ return json({ok:false, error:"valid phone required"}, 400); }
    const lead = {
      name: clip(b.name,80),
      phone,
      city: clip(b.city,40),
      service: clip(b.service,60),
      message: clip(b.message,500),
      lang: clip(b.lang,4),
      source: "website-chatbot",
      status: "new",
      createdAt: new Date().toISOString(),
      ts: Date.now()
    };
    const r = await fetch(`${DB_URL}/${NODE}.json`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lead)
    });
    if(!r.ok){ return json({ok:false, error:"db "+r.status}, 502); }
    return json({ ok:true });
  }catch(e){
    return json({ ok:false, error: String(e && e.message || e) }, 500);
  }
}
