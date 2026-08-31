/* Sedra Electric — lead capture (Cloudflare Pages Function)
   Route: POST /api/lead
   Saves the lead into the Firebase Realtime Database `leads` node in the exact
   shape the Sedra CRM expects, so chat leads appear inside the CRM leads list,
   AND (optionally) pings your team instantly on Telegram / a webhook.

   Optional env vars (Pages > Settings > Variables):
     LEAD_BRANCH   default "Egypt"
     LEAD_NODE     default "leads"
     LEAD_DB_URL   Firebase RTDB base url (default below)
     TG_TOKEN      Telegram bot token  ─┐  set both to get an instant
     TG_CHAT       Telegram chat id    ─┘  WhatsApp-like alert per new lead
     NOTIFY_WEBHOOK  any URL to POST the lead to (Zapier/Make/your own)
     TURNSTILE_SECRET  if set, requires a valid Turnstile token (anti-spam) */

const DB_DEFAULT = "https://sedra-crm-default-rtdb.firebaseio.com";

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}
const clip=(v,n)=>(v==null?'':String(v)).trim().slice(0,n);

/* Normalise an Egyptian (or international) phone into a clean, comparable form. */
function normPhone(raw){
  let d = String(raw||'').replace(/[^\d+]/g,'');
  d = d.replace(/^00/,'+');
  const digits = d.replace(/\D/g,'');
  if(/^01\d{9}$/.test(digits))  return '+20'+digits.slice(1);   // 01XXXXXXXXX → +201XXXXXXXXX
  if(/^1\d{9}$/.test(digits))   return '+20'+digits;            // 1XXXXXXXXX  → +201XXXXXXXXX
  if(/^20\d{10}$/.test(digits)) return '+'+digits;              // 20…         → +20…
  if(d.startsWith('+'))         return d;
  return digits ? ('+'+digits) : '';
}

async function turnstileOK(env, token, ip){
  if(!env.TURNSTILE_SECRET) return true;
  if(!token) return false;
  try{
    const b=new URLSearchParams(); b.append('secret',env.TURNSTILE_SECRET); b.append('response',token); if(ip) b.append('remoteip',ip);
    const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:b});
    const j=await r.json().catch(()=>({success:false})); return !!j.success;
  }catch(e){ return true; }
}

/* Instant team alert — Telegram and/or a generic webhook. Never blocks the response. */
function notifyTeam(env, lead, ctx){
  const jobs=[];
  try{
    if(env.TG_TOKEN && env.TG_CHAT){
      const text =
`🔔 New Sedra lead (${lead.source})
👤 ${lead.name}
📱 ${lead.phone}
🏙️ ${lead.city||'—'}
🛠️ ${lead.service||'—'}
🗒️ ${(lead.notes||'').slice(0,300)}
🕒 ${lead.created}`;
      jobs.push(fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id: env.TG_CHAT, text })
      }));
    }
    if(env.NOTIFY_WEBHOOK){
      jobs.push(fetch(env.NOTIFY_WEBHOOK,{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lead) }));
    }
  }catch(e){}
  const all = Promise.allSettled(jobs);
  if(ctx && ctx.waitUntil) ctx.waitUntil(all); else all.catch(()=>{});
}

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request, env } = context;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  try{
    const b = await request.json().catch(()=>({}));

    // honeypot — real users never fill the hidden "website" field
    if(clip(b.website,50)){ return json({ ok:true }); }
    if(!(await turnstileOK(env, b.ts_token, ip))){ return json({ ok:false, error:"verification failed" }, 400); }

    const phone = normPhone(b.phone);
    if(phone.replace(/\D/g,'').length < 8){ return json({ ok:false, error:"valid phone required" }, 400); }

    const node   = (env && env.LEAD_NODE)   ? env.LEAD_NODE   : "leads";
    const branch = (env && env.LEAD_BRANCH) ? env.LEAD_BRANCH : "Egypt";
    const DB     = (env && env.LEAD_DB_URL) ? env.LEAD_DB_URL : DB_DEFAULT;
    const nowIso = new Date().toISOString();
    const name = clip(b.name,80) || phone;
    const city = clip(b.city,40);
    const note = clip(b.message,500);
    const lead = {
      name, phone, email:"", branch, stage:"New", source:"Website Chatbot",
      service: clip(b.service,60), area: city, city: city, notes: note, note: note,
      owner:"", lang: clip(b.lang,4), created: nowIso, createdAt: nowIso,
      date: nowIso.slice(0,10), ts: Date.now(), ip
    };

    const r = await fetch(`${DB}/${node}.json`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(lead)
    });
    if(!r.ok){ return json({ ok:false, error:"db "+r.status }, 502); }

    notifyTeam(env, lead, context);   // instant alert (if configured)
    return json({ ok:true });
  }catch(e){
    return json({ ok:false, error: String(e && e.message || e) }, 500);
  }
}
