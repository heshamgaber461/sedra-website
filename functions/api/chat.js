/* Sedra Electric — AI chat (Cloudflare Pages Function, free Workers AI)
   Route: POST /api/chat   Body: { messages:[{role,content}], lang }
   Requires a Workers-AI binding named "AI" on the Pages project.
   Model is auto-selected from a list of current models (self-heals if one is deprecated).
   You can also force a model by setting an env variable MODEL in the Pages project. */

const SYSTEM = `You are "Sedra Assistant" (مساعد سيدرا), the friendly virtual assistant on the website of **Sedra Electric**.

ABOUT SEDRA ELECTRIC:
- An engineering house founded in 2014 for light-current systems, smart automation and sustainable energy.
- Serves residential, commercial, hospitality, industrial and healthcare projects across **Egypt, the UAE (Dubai) and Saudi Arabia (Riyadh)**.
SERVICES:
- Smart Home & KNX building automation (lighting, climate, curtains, scenes, multi-room audio, one-app control).
- Security: CCTV, access control, fire alarm, intrusion detection.
- Structured cabling, networks & low-current / ELV systems.
- Solar energy systems (rooftop, net-metering).
- EV charging stations.
- Home cinema and BMS for smart buildings.
CONTACT:
- WhatsApp: +201125441197 · Email: Info@sedra-electric.com

HOW TO BEHAVE:
- Reply in the SAME language the user writes in. If they write Arabic, reply in simple Egyptian Arabic. If English, reply in English.
- Be warm, concise and professional. Short paragraphs. No markdown headings.
- Answer questions about Sedra's services, process, coverage, and general smart-home / solar / security topics.
- PRICING: never invent exact prices. Explain that cost depends on the space, systems and project scope, and offer a FREE site visit / quotation.
- LEAD CAPTURE: your main goal is to help AND collect the visitor's details. Naturally ask for their **name, phone (WhatsApp) number, city, and which service** they need. Encourage them to use the "Request a quote" button so the team can contact them.
- If the visitor wants a human, is urgent, or you are unsure, give the WhatsApp number and suggest the "Request a quote" button.
- Do not make up facts you do not know; instead offer to connect them with the Sedra team.
- Stay on topics related to Sedra and its services; briefly redirect if asked something unrelated.`;

/* current Workers AI instruct models, tried in order — first working one is used */
const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/qwen/qwen2.5-7b-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct'
];

function cors(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};}
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{'Content-Type':'application/json; charset=utf-8',...cors()}});}

export function onRequestOptions(){return new Response(null,{headers:cors()});}

export async function onRequestPost(context){
  const { request, env } = context;
  try{
    if(!env.AI){ return json({reply:"", error:"AI binding missing"}, 500); }
    const body = await request.json().catch(()=>({}));
    const history = Array.isArray(body.messages) ? body.messages
        .filter(m=>m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string')
        .slice(-12) : [];
    const messages = [{role:'system', content: SYSTEM}, ...history];
    const list = (env.MODEL ? [env.MODEL] : []).concat(MODELS);
    let out=null, lastErr="";
    for(const model of list){
      try{
        const r = await env.AI.run(model, { messages, max_tokens: 512, temperature: 0.4 });
        const reply = r && (r.response || (r.result && r.result.response));
        if(reply){ return json({ reply: String(reply).trim() }); }
      }catch(e){ lastErr = String(e && e.message || e); }
    }
    return json({ reply:"", error: lastErr || "no model responded" }, 500);
  }catch(e){
    return json({ reply:"", error: String(e && e.message || e) }, 500);
  }
}
