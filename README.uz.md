# Click & Payme for Next.js

[English](README.md) · [Русский](README.ru.md) · **Oʻzbekcha**

> Next.js (App Router) uchun tayyor **Click** va **Payme (Paycom)** toʻlov integratsiyasi — Oʻzbekistondagi deyarli har bir mahsulotga kerak boʻladigan ikkala toʻlov gateway, birinchi urinishdayoq toʻgʻri ishlaydigan qilib yozilgan.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Ikkala gateway ham **bitta** `payment_orders` jadvali va aynan bitta Next.js Route
Handler patterni ustida ishlaydi — shu sababli bazani bir marta ulaysiz-u, ikkalasini
birvarakayiga olasiz. Protokolga aniq mos kelishi kerak boʻlgan qismlar (MD5 imzolar,
JSON-RPC konvertlar, tiyin↔UZS oʻgirish, idempotentlik) allaqachon yozib qoʻyilgan;
sizdan faqat order lookup va buyurtmani yopish (fulfilment) qismini ulash talab qilinadi, xolos.

> [!WARNING]
> Bu community loyiha. Click, Payme yoki Paycom bilan **hech qanday** aloqasi yoʻq va
> ular tomonidan tasdiqlanmagan. Productionga chiqishdan oldin hamisha quyidagi
> rasmiy hujjatlar bilan solishtirib tekshirib oling.

---

## Nega bu kerak boʻldi

Click va Payme’ni ulash birinchi qarashda oson tuyuladi, keyin esa sezdirmay bir haftangizni
yeb qoʻyadi. Xatolar oʻzini darrov bildirmaydi, koʻpchiligi esa faqat **productionda, jonli
gateway bilan ishlaganda** chiqadi — birorta tushunarli xato xabari ham boʻlmaydi. Bu repozitoriy
aynan jonli ishdan chiqishlarga (outage) sabab boʻlgan tuzoqlarni kod ichida hisobga olib qoʻygan:

- 💸 **Payme summalari tiyinda boʻladi** (1 UZS = 100 tiyin). Bir marta adashsangiz —
  100 baravar koʻp yechib olasiz yoki abadiy qaytaraverasiz.
- 📝 **Click `x-www-form-urlencoded` yuboradi, JSON emas** — `request.json()` buni
  oʻqiy olmaydi, har bir callback 400 qaytaradi, buyurtmalar esa "pending" holatda qotib qoladi.
- 🔐 **Click `prepare` va `complete` uchun ikkita boshqa-boshqa MD5 formuladan** foydalanadi.
- 🔁 **Ikkala gateway ham callback’larni qayta yuboradi** — har bir metod idempotent boʻlishi
  shart, aks holda buyurtmani ikki marta yopib qoʻyasiz yoki Payme sandbox’dan oʻtolmaysiz.
- 🧮 **Form maydonlari string boʻlib keladi** — `Int` ustunga oʻgirilmagan `"2000"`
  tushib qolsa, hammasi prepare oʻrtasida qulab tushadi va Click invoyni abadiy "Not paid"
  deb belgilab qoʻyadi.

Har birining sababi, ekranda real koʻrinadigan belgisi (symptom) bilan birga
[hujjatlar](#documentation)da tushuntirilgan.

---

## Ichida nimalar bor

```
src/
  lib/payments/
    click.ts        # MD5 sign verify (prepare + complete), body parser, URL builder, error map, types
    payme.ts        # Basic-auth verify, JSON-RPC helpers, checkout URL builder, error codes, types
    schema.ts       # Drizzle `payment_orders` table (shared by both gateways)
    store.ts        # The integration seam — order lookup + fulfilment (you implement fulfilOrder)
  app/api/payments/
    click/prepare/route.ts      # Click action=0
    click/complete/route.ts     # Click action=1
    payme/callback/route.ts     # All six Payme JSON-RPC methods
docs/
  click.md            # Full Click setup guide + every gotcha
  payme.md            # Full Payme setup guide + every gotcha
  deployment-notes.md # The nginx / callback gotchas that take down go-lives
```

**Moʻljallangan stack:** Next.js App Router · TypeScript · Postgres · Drizzle ORM.
Kripto/protokol kodi ORM’dan mustaqil; faqat `schema.ts` va `store.ts` Drizzle’ga
bogʻliq, ularni boshqa ORM’ga koʻchirish ham oson.

---

## Tez boshlash

Bu — **fayllarni koʻchirib qoʻyiladigan starter**, npm paket emas. Route handler’lar
sizning ilovangiz bazasiga murojaat qiladi, shuning uchun fayllarni mavjud Next.js
loyihangiz ichiga tashlaysiz.

1. **Kodni koʻchiring**

   ```bash
   cp -r src/lib/payments      <your-app>/src/lib/payments
   cp -r src/app/api/payments  <your-app>/src/app/api/payments
   ```

2. **Jadvalni qoʻshing** — [`src/lib/payments/schema.ts`](src/lib/payments/schema.ts)
   dagi `payment_orders`’ni oʻz Drizzle schema’ngizga qoʻshib qoʻying, soʻng
   `npx drizzle-kit generate && npx drizzle-kit migrate`.

3. **Ulanish nuqtasini (seam) yozing** —
   [`src/lib/payments/store.ts`](src/lib/payments/store.ts)’ni oching va
   `fulfilOrder()`’ni toʻldiring (foydalanuvchiga ruxsat bering yoki xarid yozuvini yarating).
   Qolgani tayyor.

4. **Maxfiy kalitlarni kiriting** — [`.env.example`](.env.example)’ni `.env.local`’ga
   koʻchiring va Click hamda Payme kalitlaringizni toʻldiring.

5. **Callback URL’laringizni** har bir gateway’da roʻyxatdan oʻtkazing (hujjatlarga qarang):
   - Click → `POST /api/payments/click/prepare` va `/complete`
   - Payme → `POST /api/payments/payme/callback`

6. **Sinab koʻring** — Payme’da [sandbox](https://test.paycom.uz/) bor; Click esa oʻz
   tomonidan test kartalar bilan tekshiradi. [Go-live checklist](docs/)lar boʻylab toʻliq
   oʻtib chiqing.

---

## Documentation

| Qoʻllanma | Nimani qamrab oladi |
|---|---|
| **[docs/click.md](docs/click.md)** | Click SHOP API — prepare/complete oqimi, ikkala MD5 formula, 8 ta gotcha, error code’lar, go-live checklist |
| **[docs/payme.md](docs/payme.md)** | Payme JSON-RPC — oltita metodning hammasi, tiyin oʻgirish, sandbox idempotentlik testlari, error code’lar, go-live checklist |
| **[docs/deployment-notes.md](docs/deployment-notes.md)** | nginx trailing-slash `ERR_TOO_MANY_REDIRECTS` tuzogʻi va go-live’ni buzadigan boshqa callback’ga yetib borish muammolari |

**Rasmiy manbalar:** [Click SHOP API](https://docs.click.uz/en/shop-api/) ·
[Payme developer docs](https://developer.help.paycom.uz/) ·
[Payme sandbox](https://test.paycom.uz/)

---

## Oqimlar qanday ishlaydi

**Click** (karta formasini gateway’ning oʻzi koʻrsatadi):

```
User → your create-order route → redirect to my.click.uz/services/pay
   → Click calls POST /click/prepare  (action=0)  → you return merchant_prepare_id
   → Click charges the card
   → Click calls POST /click/complete (action=1)  → you fulfil the order
   → Click redirects the browser back to your return_url
```

**Payme** (checkout’ni gateway’ning oʻzi koʻrsatadi):

```
User → your create-order route → redirect to checkout.paycom.uz/<base64>
   → Payme calls your single callback over JSON-RPC:
       CheckPerformTransaction → CreateTransaction → PerformTransaction
   → on PerformTransaction you fulfil the order
   → browser returns to your return_url
```

---

## Contributing

Issue va PR’lar mamnuniyat bilan qabul qilinadi — ayniqsa siz productionda
duch kelgan qoʻshimcha gotcha’lar, error code tuzatishlari yoki boshqa ORM’larga
(Prisma, Kysely) portlar. Oʻzgartirishlarni aniq-tiniq (surgical) va hujjatlangan
holatda qoldiring.

## License

[MIT](LICENSE) — istalgancha, jumladan tijorat maqsadida ham bemalol foydalaning.
Hech qanday kafolat yoʻq; toʻlov kodini jonli pul bilan ishga tushirishdan oldin
tekshirib koʻrish — sizning zimmangizdagi masʼuliyat.
