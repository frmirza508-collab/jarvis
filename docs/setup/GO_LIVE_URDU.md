# JARVIS Go-Live Guide (Roman Urdu)

Yeh woh kaam hain jo **aap ke apne account, shanakht (ID) aur payment** se hote hain. Code aur automation sab tayyar hai. Aap ko sirf account bana kar keys paste karni hain.

> ⚠️ **Security:** API keys, private key aur passwords kabhi chat, email ya GitHub mein paste na karein. Yeh sirf JARVIS app ya hosting dashboard ke "secret" fields mein jaati hain. Public key aur server URL share karna theek hai.

---

## 1. OpenRouter key (zaroori — AI ke liye)

1. https://openrouter.ai par jaayen → **Sign in** (Google/GitHub/email).
2. **Credits** → card se credit add karein. Pay-per-use hai; $5–10 se shuru kar sakte hain.
3. **Keys** → **Create Key** → naam "JARVIS" → key copy karein (`sk-or-v1-…`). Yeh sirf ek dafa dikhti hai.
4. JARVIS app → **Settings → Providers → OpenRouter API key** → paste → **Save** → **Test**.
5. **Settings → Models** mein har role ke liye model list se chunein (list OpenRouter se live aati hai).

Optional: key par monthly spending limit laga dein (OpenRouter key settings).

## 2. Web search aur voice keys (optional)

| Cheez                   | Kahan se                                                                               | App mein kahan                            |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| Brave Search            | https://api-dash.search.brave.com → plan subscribe → API key                           | Settings → Providers → Brave              |
| Tavily (Brave ki jagah) | https://tavily.com → sign up → API key                                                 | Settings → Providers → Tavily             |
| Speech-to-text          | OpenAI (https://platform.openai.com → API keys), ya koi bhi Whisper-compatible service | Settings → Providers → Speech-to-text key |

- Agar aap OpenAI ke ilawa koi Whisper-compatible service (maslan Groq) istemal karein to `%APPDATA%\JARVIS\settings.json` mein `stt.baseUrl` aur `stt.model` us service ke docs ke mutabiq badlein.
- Urdu/Chinese awaaz ke liye: **Windows Settings › Time & language › Speech › Add voices** se Urdu aur Chinese voices install karein.

## 3. Database + license server hosting

### Aasaan tareeqa: Render (one-click blueprint — repo mein `render.yaml` tayyar hai)

1. Pehle yeh branch `main` mein merge karein (ya Render mein yahi branch chunein).
2. https://render.com → GitHub se sign in → **New → Blueprint** → `frmirza508-collab/jarvis` repo chunein.
3. Render teen cheezein banayega: **jarvis-db** (PostgreSQL), **jarvis-license-api**, **jarvis-admin**. Plan aur qeemat dashboard mein check karein. Free database kuch din baad expire ho jata hai, is liye production ke liye paid plan lein.
4. Apne computer par (repo folder mein) keys aur admin banayein. `DATABASE_URL` Render → jarvis-db → **External Database URL** se lein:
   ```bash
   pnpm install
   DATABASE_URL="<external database URL>" ADMIN_EMAIL="aap@example.com" ADMIN_PASSWORD="<kam az kam 10 characters>" pnpm setup:server
   ```
   Yeh `.secrets/license-private.pem` banata hai. **Iska backup mehfooz jagah rakhein.** Agar yeh kho gaya to sab licenses dobara issue karne parenge.
5. Render → **jarvis-license-api → Environment** mein bharein:
   - `LICENSE_SIGNING_PRIVATE_KEY` = setup script ka "Private key as one line" output
   - `ADMIN_ORIGINS` = jarvis-admin ka URL (maslan `https://jarvis-admin.onrender.com`)
   - `PUBLIC_BASE_URL` = jarvis-license-api ka URL
6. Render → **jarvis-admin → Environment**: `VITE_LICENSE_API_URL` = license API ka URL → **Manual Deploy**.
7. Check karein: `https://<license-api-url>/health` par `{"ok":true}` aana chahiye. Admin URL khol kar apne admin email se login karein.

### Doosra tareeqa: apna VPS (Hetzner, DigitalOcean, local data center)

`infra/deployment/docker-compose.yml` istemal karein (PostgreSQL + API). Aage HTTPS ke liye Caddy ya Nginx lagayein.

## 4. Release installer banana (license ke saath)

GitHub repo → **Settings → Secrets and variables → Actions**:

- **Secret** `JARVIS_LICENSE_PUBLIC_KEY` = setup script ka `JARVIS_LICENSE_PUBLIC_KEY` value
- **Variable** `JARVIS_LICENSE_API_URL` = license API URL
- **Variable** `VITE_ACCOUNT_URL` (optional) = jahan customers payment ki maloomat dekhein

Phir **Actions → CI** chalayen. "Windows installer" job ke artifacts mein `JARVIS-Setup-x.y.z-x64.exe` milega.

## 5. Payments

- **Abhi se kaam karta hai: bank transfer / JazzCash / Easypaisa (manual).** Customer payment karta hai, aap Admin → Customers → **Record payment** mein reference daalte hain, subscription foran active ho jati hai, phir **Issue license** se key customer ko bhej dein.
- **Stripe:** Stripe Pakistan mein registered businesses ko account nahi deta. Sirf tab use ho sakta hai jab aap ki company Stripe-supported mulk (US, UK, UAE waghera) mein registered ho. Account ho to `STRIPE_SECRET_KEY` aur `STRIPE_WEBHOOK_SECRET` Render environment mein daalein aur webhook `https://<license-api>/v1/webhooks/stripe` banayein (events `docs/licensing/LICENSING.md` mein hain).
- **Pakistani online gateway (Safepay, PayFast, JazzCash/Easypaisa merchant, bank IPG):** pehle merchant account banayein (business documents lagte hain). Jab sandbox credentials aur un ke official API docs mil jaayen, un ka adapter JARVIS ke "signed gateway" system se joda ja sakta hai.

## 6. Code-signing certificate (Windows warning khatam karne ke liye)

- **OV code-signing certificate** kisi certificate authority se khareedein (maslan Certum, Sectigo, SSL.com, DigiCert). Individual ke liye ID verification hoti hai, company ke liye registration documents.
- Aaj kal private key hardware token ya cloud signing service par hoti hai. CI (GitHub Actions) ke liye **cloud signing** wala option lein.
- Certificate milne ke baad: PFX file ho to `JARVIS_SIGN_PFX` / `JARVIS_SIGN_PASSWORD` set karein. Cloud signing ho to us provider ka signing step CI mein joda jaayega.
- Signing ke baad bhi SmartScreen reputation waqt ke saath banti hai. EV certificate (company ke liye) se warning jaldi khatam hoti hai.

## Checklist

- [ ] OpenRouter account + credit + key → app mein test
- [ ] (Optional) Brave/Tavily key, STT key, Urdu/Chinese Windows voices
- [ ] Render blueprint → `pnpm setup:server` → environment values → health check → admin login
- [ ] GitHub secret/variables → CI se release installer
- [ ] Admin mein test customer → payment record → license key → app mein activate
- [ ] (Baad mein) payment gateway merchant account, code-signing certificate
