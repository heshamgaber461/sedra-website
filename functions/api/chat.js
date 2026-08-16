/* Sedra Electric — AI chat (Cloudflare Pages Function, free Workers AI)
   Route: POST /api/chat   Body: { messages:[{role,content}], lang }
   - Requires a Workers-AI binding named "AI".
   - Optional env vars (set in Pages > Settings > Variables): MODEL, SYSTEM_PROMPT
     (SYSTEM_PROMPT lets you tune the assistant's knowledge/voice without editing code). */

const SYSTEM_DEFAULT = `You are "Sedra Assistant" — the smart, friendly assistant on the Sedra Electric website. You represent the brand and talk in Sedra's voice: confident, warm, engineering-led, helpful, and human. Keep answers concise and useful. Never sound robotic.

LANGUAGE: Reply in the SAME language the visitor uses. For Arabic, use natural EGYPTIAN Arabic (بلهجة مصرية بسيطة ودودة) — like a knowledgeable Sedra sales engineer chatting on WhatsApp. For English, warm professional English. Never mix languages in one reply. No markdown headings, no bullet dumps — short friendly paragraphs.

WHO WE ARE:
Sedra Electric — a Cairo-based engineering house founded in 2014, specialised in light-current systems, smart automation and sustainable energy. Turnkey (from consultation to lifetime support). We serve homes, offices, hospitality, industrial and healthcare projects across Egypt, the UAE (Dubai) and Saudi Arabia (Riyadh).

WHAT WE DO (be ready to explain any of these in detail, with real benefits):
1) Smart Home & KNX automation — smart lighting, climate/AC control, automatic curtains/blinds, scenes (e.g. "Movie", "Goodbye", "Morning"), multi-room audio, and control of everything from one app anywhere in the world; integrates with voice assistants.
2) Security & surveillance — CCTV cameras, access control, fire alarm, intrusion detection, live monitoring and phone alerts.
3) Networks & low-current (ELV) — structured cabling, Wi-Fi coverage, data/networking, intercom, and complete low-current infrastructure.
4) Solar energy — rooftop solar systems with net-metering to cut the electricity bill; typical payback is roughly 5–7 years (give this as an estimate, not a promise).
5) EV charging — home and compound EV charging stations.
6) Home cinema and BMS for smart buildings.

HOW WE WORK (mention when relevant): free consultation → site survey & design → clear quotation → professional installation → testing & handover → training and after-sales support/maintenance. We're engineering-led, deliver on schedule, and stand behind our work after the sale.

COVERAGE: Egypt (Cairo, New Cairo, Sheikh Zayed, 6th of October, New Administrative Capital and more), UAE (Dubai), KSA (Riyadh).

PRICING: There is no fixed price — it depends on the space (m²), which systems, and the finishing level. Never invent numbers or quote a figure. Explain this simply and offer a FREE site visit / quotation.

YOUR GOAL: genuinely help AND collect the visitor's details. Answer their question well first, then naturally ask for their NAME, PHONE (WhatsApp), CITY, and which SERVICE they're interested in, and invite them to press the "Request a quote" button so the team calls them. If they want a human, are in a hurry, or you're unsure — give WhatsApp +201125441197 (or email Info@sedra-electric.com) and suggest the quote button.

RULES: Be accurate; if you don't know something, say you'll connect them with the Sedra team rather than guessing. Stay on Sedra-related topics; if asked something unrelated, answer briefly and steer back warmly. Always be encouraging and make the visitor feel taken care of.`;

/* Small & fast models FIRST so replies come back in ~1-3s.
   The big models stay only as a last-resort fallback. */
const MODELS = [
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/qwen/qwen2.5-7b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct']
;

const PER_MODEL_TIMEOUT_MS = 9000; // if a model stalls, abandon it fast and try the next

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}

function withTimeout(promise, ms){
  return Promise.race([
    promise,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('model-timeout')), ms))
  ]);
}

/* ---- auto lead-capture straight from the chat conversation ---- */
const LEAD_DB = "https://sedra-crm-default-rtdb.firebaseio.com";
function toAscii(s){return String(s||"").replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d));}
/* Egyptian mobile: 01[0125]+8 digits, with or without +20 / 0020 country code */
function findPhone(t){const d=toAscii(t).replace(/\D/g,"");const m=d.match(/(?:0020|20)?0?(1[0125]\d{8})(?!\d)/);return m?("0"+m[1]):"";}
/* best-effort name only from an explicit marker, else we fall back to the phone */
function findName(history){
  for(let i=history.length-1;i>=0;i--){const h=history[i];if(!h||h.role!=='user')continue;
    const m=String(h.content).match(/(?:اسمي|إسمي|my name is|i'?m called|this is)\s*[:\-]?\s*([\p{L}][\p{L} ]{1,28})/iu);
    if(m){const n=m[1].trim().replace(/\s+/g," ").split(" ").slice(0,3).join(" ");if(n)return n;}
  }
  return "";
}
function findPhoneIn(history){for(let i=history.length-1;i>=0;i--){const h=history[i];if(!h||h.role!=='user')continue;const p=findPhone(h.content);if(p)return p;}return "";}
/* light city/area detector (best-effort) — the full text always stays in notes anyway */
const CITIES=["القاهره","القاهرة","cairo","الجيزه","الجيزة","giza","الاسكندريه","الاسكندرية","اسكندريه","alexandria","الشيخ زايد","شيخ زايد","زايد","sheikh zayed","zayed","اكتوبر","أكتوبر","october","التجمع","القاهره الجديده","القاهرة الجديدة","new cairo","العاصمه الاداريه","العاصمة الإدارية","new capital","المنصوره","المنصورة","طنطا","دبي","dubai","الرياض","riyadh","الامارات","السعوديه","السعودية"];
function findCity(history){const t=history.map(h=>String(h.content||"")).join("  ").toLowerCase();for(const c of CITIES){if(t.includes(c.toLowerCase()))return c;}return "";}
/* upsert by a deterministic per-phone key so the SAME lead gets updated, never duplicated */
async function upsertLead(key,patch){try{await fetch(LEAD_DB+"/leads/"+key+".json",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(patch)});}catch(e){}}

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request, env } = context;
  try{
    if(!env.AI){ return json({reply:"", error:"AI binding missing"}, 500); }
    const body = await request.json().catch(()=>({}));
    const history = Array.isArray(body.messages) ? body.messages
        .filter(m=>m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string')
        .slice(-10) : [];

    /* If the visitor gave a phone number anywhere in the chat, upsert them as ONE lead
       (same phone = same lead, updated as they add more info like their address).
       Runs in the background so it never slows down the reply. */
    try{
      const phone = findPhoneIn(history);
      if(phone){
        const nowIso = new Date().toISOString();
        const convo = history.slice(-8).map(m=>(m.role==='user'?'👤':'🤖')+' '+m.content).join('  |  ').slice(0,700);
        const city = findCity(history);
        const patch = { name: findName(history) || phone, phone, branch:"Egypt",
          stage:"New", source:"Website Chatbot", owner:"",
          notes:"Chat: "+convo, note:"Chat: "+convo, lang:(body.lang==='ar'||body.lang==='en')?body.lang:"",
          created:nowIso, createdAt:nowIso, date:nowIso.slice(0,10), updatedAt:nowIso, ts:Date.now() };
        if(city){ patch.area=city; patch.city=city; }
        const key = "chat_"+phone.replace(/\D/g,"");
        if(context.waitUntil) context.waitUntil(upsertLead(key,patch)); else upsertLead(key,patch);
      }
    }catch(e){}
    const system = (env.SYSTEM_PROMPT && env.SYSTEM_PROMPT.trim()) ? env.SYSTEM_PROMPT : SYSTEM_DEFAULT;
    const messages = [{role:'system', content: system}, ...history];
    const list = (env.MODEL ? [env.MODEL] : []).concat(MODELS);
    let lastErr="";
    for(const model of list){
      try{
        const r = await withTimeout(
          env.AI.run(model, { messages, max_tokens: 320, temperature: 0.5 }),
          PER_MODEL_TIMEOUT_MS
        );
        const reply = r && (r.response || (r.result && r.result.response));
        if(reply){ return json({ reply: String(reply).trim(), model }); }
      }catch(e){ lastErr = String(e && e.message || e); }
    }
    return json({ reply:"", error: lastErr || "no model responded" }, 500);
  }catch(e){
    return json({ reply:"", error: String(e && e.message || e) }, 500);
  }
}
