# Getting the Microsoft credentials

Three values go in `.env.local`:

| Variable | Where it comes from |
|---|---|
| `MS_CLIENT_ID` | Copied from the app registration you create below |
| `MS_CLIENT_SECRET` | Generated inside that app registration |
| `MS_REDIRECT_URI` | **You choose this**, then register it on the app. It is not issued to you. |

You create the app registration **once**, in your own Microsoft account. It is
not per-distributor. Each distributor then consents to it at sign-in, which is
the "owner authorizes once" step in the PRD.

You do not need a paid Microsoft 365 subscription to create it. You do need a
Microsoft 365 mailbox to actually test against one.

---

## 1. Create the app registration

1. Sign in at **https://entra.microsoft.com** (the Microsoft Entra admin
   centre). If you land in the Azure portal instead, search for
   **Microsoft Entra ID** — it is the same thing under its older name.
2. In the left menu: **Entra ID → App registrations → New registration**.
3. **Name**: anything you will recognise, e.g. `Quote Desk`.
4. **Supported account types**: choose

   > **Accounts in any organizational directory (Any Microsoft Entra ID tenant — Multitenant)**

   This one matters. Every distributor is a separate Microsoft tenant, and a
   single-tenant app can only ever sign in people from your own directory. Pick
   single-tenant here and no customer will ever be able to connect.
5. **Redirect URI**: set the platform to **Web** and the value to exactly

   ```
   http://localhost:3000/api/graph/callback
   ```

   (For anything other than local development, see §4.)
6. **Register**.

On the overview page that appears, copy **Application (client) ID**. That is
your `MS_CLIENT_ID`.

---

## 2. Create the client secret

1. In that app: **Certificates & secrets → Client secrets → New client secret**.
2. Description: anything. Expiry: 24 months is the longest offered.
3. **Add**.
4. Copy the **Value** column — a string of random characters.

   Copy the **Value**, not the **Secret ID**. They sit next to each other and
   the Secret ID is a UUID that looks equally credential-shaped. Only the Value
   works, and it is shown **once**: navigate away and you will have to delete
   the secret and make a new one.

That is your `MS_CLIENT_SECRET`.

---

## 3. Add the permissions

1. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**.
2. Tick these five:

   | Permission | Why |
   |---|---|
   | `Mail.Read.Shared` | Reads the **shared** quotes mailbox. This is the one that actually matters — see the note below. |
   | `Mail.Read` | Covers the case where a distributor points us at an owner's own inbox rather than a shared one. |
   | `offline_access` | Lets us keep watching after the owner closes the browser. Without it the connection dies in an hour. |
   | `User.Read` | Identifies who signed in. |
   | `openid` | Required for the sign-in itself. |

3. **Add permissions**.

**Why `Mail.Read.Shared` and not just `Mail.Read`:** `Mail.Read` grants access
to the signed-in user's *own* mailbox only. The whole premise here is watching
`quotes@distributor.com`, which is a different mailbox that the owner has Full
Access to. With only `Mail.Read`, Microsoft returns 403 on every request and
the connection looks broken for no visible reason.

Do **not** add `Mail.Send` or any `.Write` permission. The system never sends
from a distributor's mailbox on its own, and asking for a permission you do not
use is a question you will have to answer during their security review.

You do not need to press "Grant admin consent" for your own directory — each
distributor's admin consents for theirs when the owner connects the mailbox.

---

## 4. The redirect URI, and the webhook problem

`MS_REDIRECT_URI` must match what you registered in step 1 **character for
character** — trailing slashes count. For local work:

```
MS_REDIRECT_URI=http://localhost:3000/api/graph/callback
```

`http://localhost` is the one exception Microsoft allows; every other redirect
URI must be `https`.

**The catch.** OAuth redirects go to *your browser*, so localhost is fine for
sign-in. But the Graph **webhook** is Microsoft's servers calling *you*, and
they cannot reach `localhost`. When the app creates a subscription, Microsoft
immediately calls `NEXT_PUBLIC_APP_URL/api/graph/webhook` with a validation
token and refuses to create the subscription unless it gets an answer within
about ten seconds.

So connecting a real mailbox needs a publicly reachable HTTPS URL. Two ways:

**A tunnel, for testing on your machine**

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words-here.trycloudflare.com`. Then set
**both** of these to it and restart `npm run dev`:

```
NEXT_PUBLIC_APP_URL=https://random-words-here.trycloudflare.com
MS_REDIRECT_URI=https://random-words-here.trycloudflare.com/api/graph/callback
```

and add that same redirect URI to the app registration
(**Authentication → Add URI**). The tunnel URL changes every restart on the free
tier, and both places have to be updated together each time.

**A deployment, for the pilot.** Deploy to Vercel, then use the real domain in
both variables and register the redirect URI once. This is what the design
partner will actually run against.

Everything except connecting a live mailbox works fine on plain localhost:
sign-in, the catalogue import, the review screen, and `npm run verify:intake`,
which exercises the webhook by calling it directly.

---

## 5. Put them in `.env.local`

```
MS_CLIENT_ID=<Application (client) ID from step 1>
MS_CLIENT_SECRET=<the secret Value from step 2>
MS_REDIRECT_URI=<exactly what you registered>
```

Restart `npm run dev` — the values are read at server start.

Then go to **Settings → Mailbox** in the app. It tells you if anything is still
missing rather than failing obscurely. Enter the shared mailbox address and
press **Continue with Microsoft**.

---

## What the distributor sees

When their owner connects the mailbox, Microsoft shows them a consent screen
listing exactly what is being asked for: read mail in shared mailboxes, read
their mail, sign them in, and stay signed in. If their tenant requires admin
approval for new applications, their IT administrator has to approve it once —
worth asking about before the onboarding call rather than discovering it while
they watch.

The owner also needs **Full Access** to the shared mailbox in Exchange. They
almost always do, since it is their quotes inbox, but it is the first thing to
check if the connection succeeds and then reads nothing.

---

## When it goes wrong

| What you see | Cause |
|---|---|
| `AADSTS50011: redirect URI does not match` | `MS_REDIRECT_URI` differs from the registered value. Compare them character by character, including the trailing slash. |
| `AADSTS7000215: Invalid client secret` | The Secret ID was copied instead of the Value, or the secret expired. |
| `AADSTS650057` / consent errors | A permission from §3 is missing, or the tenant requires admin approval. |
| Subscription creation fails, or nothing arrives | `NEXT_PUBLIC_APP_URL` is not publicly reachable over HTTPS. See §4. |
| Connects, then 403 on every read | `Mail.Read.Shared` is missing, or the owner lacks Full Access to the shared mailbox. |

The mailbox settings screen shows the last error against the connection, and
every failure is recorded in `activity_log` and `mailbox_connections.last_error`.
