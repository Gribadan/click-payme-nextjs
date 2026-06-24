# Click & Payme for Next.js

[English](README.md) · **Русский** · [Oʻzbekcha](README.uz.md)

> Готовая интеграция платёжек **Click** и **Payme (Paycom)** для Next.js (App Router) — два шлюза, без которых в Узбекистане не обходится ни один продукт, собранные так, чтобы всё завелось с первого раза.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-App_Router-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Оба шлюза работают через **одну** таблицу `payment_orders` и один и тот же
паттерн route handler в Next.js — БД настраиваешь один раз и сразу получаешь оба.
Всё, что критично сделать строго по протоколу (подписи MD5, конверты JSON-RPC,
конвертация тийин↔UZS, идемпотентность), уже написано и готово к работе; от тебя
нужны только поиск своего заказа и его выдача.

> [!WARNING]
> Это community-проект. Он **никак** не связан с Click, Payme или Paycom и ими
> не поддерживается. Перед запуском в прод обязательно сверяйся с официальной
> документацией по ссылкам ниже.

---

## Зачем это всё

Интеграция Click и Payme на первый взгляд кажется простой, а потом незаметно
съедает целую неделю. Грабли тут неочевидные, и большинство из них вылезает
**только в проде, на боевом шлюзе** — внятной ошибки ты при этом не увидишь. В этом
репозитории собраны как раз те подводные камни, из-за которых реально падал прод:

- 💸 **Суммы в Payme считаются в тийинах** (1 UZS = 100 тийин). Ошибёшься один
  раз — спишешь в 100 раз больше или будешь бесконечно возвращать деньги.
- 📝 **Click шлёт POST в формате `x-www-form-urlencoded`, а не JSON** —
  `request.json()` его не переварит, каждый коллбэк падает с 400, а заказы
  висят в статусе «pending».
- 🔐 **У Click две разные формулы MD5** — для `prepare` и для `complete`.
- 🔁 **Оба шлюза ретраят коллбэки** — каждый метод обязан быть идемпотентным,
  иначе словишь двойную выдачу или завалишь тесты в песочнице Payme.
- 🧮 **Поля формы приходят строками** — незакастованная `"2000"` в колонку типа
  `Int` уронит обработку прямо на этапе prepare, и Click навсегда пометит счёт
  как «Not paid».

В [документации](#documentation) каждый из этих случаев разобран вместе с тем
симптомом, который ты реально увидишь.

---

## Что внутри

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

**Стек, на который рассчитан проект:** Next.js App Router · TypeScript · Postgres · Drizzle ORM.
Криптография и логика протокола от ORM не зависят; на Drizzle завязаны только
`schema.ts` и `store.ts`, и переписать их под другую ORM несложно.

---

## Быстрый старт

Это **стартер, который копируется в проект**, а не npm-пакет — роуты ходят
в БД твоего приложения, поэтому файлы просто кладёшь в существующий проект на
Next.js.

1. **Скопируй исходники**

   ```bash
   cp -r src/lib/payments      <your-app>/src/lib/payments
   cp -r src/app/api/payments  <your-app>/src/app/api/payments
   ```

2. **Добавь таблицу** — перенеси `payment_orders` из
   [`src/lib/payments/schema.ts`](src/lib/payments/schema.ts) в свою Drizzle-схему,
   затем выполни `npx drizzle-kit generate && npx drizzle-kit migrate`.

3. **Реализуй точку стыковки** — открой
   [`src/lib/payments/store.ts`](src/lib/payments/store.ts) и допиши
   `fulfilOrder()` (выдача доступа / создание записи о покупке). Всё остальное
   уже готово.

4. **Пропиши ключи** — скопируй [`.env.example`](.env.example) в `.env.local`
   и заполни своими ключами Click и Payme.

5. **Зарегистрируй URL коллбэков** у каждого шлюза (см. документацию):
   - Click → `POST /api/payments/click/prepare` и `/complete`
   - Payme → `POST /api/payments/payme/callback`

6. **Протестируй** — у Payme есть [песочница](https://test.paycom.uz/); Click
   проверяет со своей стороны тестовыми картами. Пройди
   [чек-листы перед запуском](docs/).

---

## Documentation

| Гайд | О чём он |
|---|---|
| **[docs/click.md](docs/click.md)** | Click SHOP API — флоу prepare/complete, обе формулы MD5, 8 граблей, коды ошибок, чек-лист перед запуском |
| **[docs/payme.md](docs/payme.md)** | Payme JSON-RPC — все шесть методов, конвертация тийин, тесты идемпотентности в песочнице, коды ошибок, чек-лист перед запуском |
| **[docs/deployment-notes.md](docs/deployment-notes.md)** | Грабли с trailing-slash в nginx и `ERR_TOO_MANY_REDIRECTS`, а также другие проблемы с доступностью коллбэков, которые ломают запуск |

**Официальные источники:** [Click SHOP API](https://docs.click.uz/en/shop-api/) ·
[документация для разработчиков Payme](https://developer.help.paycom.uz/) ·
[песочница Payme](https://test.paycom.uz/)

---

## Как устроены флоу

**Click** (форму карты хостит шлюз):

```
User → your create-order route → redirect to my.click.uz/services/pay
   → Click calls POST /click/prepare  (action=0)  → you return merchant_prepare_id
   → Click charges the card
   → Click calls POST /click/complete (action=1)  → you fulfil the order
   → Click redirects the browser back to your return_url
```

**Payme** (страницу оплаты хостит шлюз):

```
User → your create-order route → redirect to checkout.paycom.uz/<base64>
   → Payme calls your single callback over JSON-RPC:
       CheckPerformTransaction → CreateTransaction → PerformTransaction
   → on PerformTransaction you fulfil the order
   → browser returns to your return_url
```

---

## Contributing

Issues и PR приветствуются — особенно новые грабли, на которые ты напоролся в
проде, правки в кодах ошибок или порты на другие ORM (Prisma, Kysely). Меняй
точечно и не забывай про документацию.

## License

[MIT](LICENSE) — используй свободно, в том числе в коммерции. Гарантий никаких;
платёжный код — твоя зона ответственности, проверь его до того, как через него
пойдут реальные деньги.
