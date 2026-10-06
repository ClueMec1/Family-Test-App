# Owner Manager

The back office for a grocery shop: inventory with low-stock alerts, customer credit accounts, promotions,
card device profiles, shop-wide settings, and the link to your registers. It runs in the browser, works
with no internet, and installs as its own app.

Registers run the **Checkout Terminal**, a separate app. This download does not include it.

| File | What it is |
|---|---|
| `owner_manager.html` | The manager |
| `sw.js`, `manager.webmanifest`, `icon-*.png` | Make it installable and available offline |
| `inventory_db.sample.json` | Practice data: 14 items, 4 promotions, 3 customers, 2 device profiles |

## Run it

Keep these files together in their own folder and serve that folder from the owner's computer, then open
the page at a `localhost` address. With Python installed:

    python -m http.server 8000

Open `http://localhost:8000/owner_manager.html` in Chrome or Edge. Use the browser's install button to add
it as an app. After the first load it opens with the server stopped.

## First run

1. Choose a 4-digit PIN. It unlocks this manager, authorises exports, and is what a register asks for
   before it loads a file.
2. Add items, customers, promotions and card devices. To practise, press **Import a sync file** and pick
   `inventory_db.sample.json`. Its default card device is a simulator that charges nothing; delete that
   profile before trading.

## Getting your data to the registers

**Wi-Fi sync (automatic)**

1. **Settings**, switch on **Wi-Fi sync**. Keep this page open; it keeps hosting while locked.
2. Open the Checkout Terminal on a register. It lists this shop by name; the employee picks it.
3. A request appears here with a 4-digit code. If the register shows the same code, press **Allow**.

Each register is allowed once. After that it sends every sale here and receives your changes within a
second or so.

- Every change you make is timestamped, and the newest timestamp wins on every computer.
- Sales are never overwritten. Each has an ID, and this manager applies each one once to stock and
  customer balances.
- If this computer is off, registers keep selling and send their sales when it is back.
- If this computer is replaced, set a PIN on the new one, switch on Wi-Fi sync, and link the registers
  to it (Alt+Shift+H on each register). It starts empty and takes the newest copy from the first
  register that joins.
- A timestamp more than ten minutes in the future (a wrong clock) is ignored.

**With a file**

1. Press **Compile & Export Sync File** and enter the PIN. The browser saves `inventory_db.json`.
2. Drop that file on the register's screen and enter the PIN there.

To bring a register's sales, stock counts and balances back: on the register press Alt+Shift+E to export
its file, then here press **Import a sync file** and choose **Pull register activity**. Do this before
your next export, or the register's numbers are overwritten by older ones. The file method suits one
register; use Wi-Fi sync for more.

**Same computer**

If the Checkout Terminal runs in the same browser at the same address, the two share data directly with
no setup. Put the two app folders side by side and start the server in the folder above them:

    http://localhost:8000/owner_manager/owner_manager.html
    http://localhost:8000/checkout_terminal/checkout_terminal.html

## Promotions

- **Percentage** and **dollar** promotions are coupons, applied when the cashier scans or types the code.
  A dollar coupon comes off each matching unit, or once off the whole order when it applies to all.
- A promotion whose code is an item's own barcode applies whenever that item is sold.
- **Clearance** is always on, is a percentage off the regular price, and coupons skip clearance items.

## Customer credit

Accounts are identified by phone number. A charge sets the due date to that day plus your payment window,
unless the customer already owes. An account past due with a balance freezes by itself and unfreezes when
the balance is paid, here or at a register.

## Card devices

Under **Payment devices**, add a profile for each terminal: a label, the provider, whether it connects by
LAN address or serial port, and the address. One profile is the default; each register asks once which
profile it uses. The registers send a generic message and wait for "approved"; terminals from Clover,
Verifone, Ingenico, PAX and Square need a small bridge program to translate. The panel on that screen and
the Checkout Terminal's README show the exact message.

## Things to know

- The PIN keeps staff out of owner functions. It is not encryption: a 4-digit PIN can be guessed by
  someone who has an exported file, and that file holds customer names, phone numbers and balances in
  plain text. Treat exports like the cash drawer.
- Clearing the browser's site data erases the shop's data on this computer. Export regularly and keep the
  files as backups.
- Wi-Fi sync needs every computer on the same network with router "client isolation" off, and internet
  for a moment when a page opens or reconnects. Two free public services make the introduction
  (`ntfy.sh` and `api.ipify.org`); prices, sales and customer details never pass through them. This was
  tested with a stand-in for those services on one machine, so try it on your own network first.
- After replacing these files with a newer version, change `v1` in `sw.js` to `v2` so browsers pick up the
  update.
