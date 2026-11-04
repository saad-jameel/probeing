/* Item 40: bank alerts read off the phone's notifications. A classic script, like day.js:
 * activity-ingest imports it and the node tests load it. No import/export; strict-mode safe.
 *
 * The phone sends {app, title, text, at, key}: the notification's own app label and title, its text with every
 * run of 7+ digits blanked (account, phone and transaction numbers), the post time and a hash for dedupe.
 * bankParse turns one into {bank, dir, amount, party}, or null when it is not a payment it can read. */

var BANK_PARTY_MAX = 60;
var BANK_SMS_SENDERS = { '14250': 'HBL' };            // an SMS alert, by its sender (the notification's title)
var BANK_APPS = [['hbl', 'HBL'], ['easypaisa', 'Easypaisa'], ['jazzcash', 'JazzCash']];
// Words that end a name: the bank the money went to or came from, or the account phrase after it.
var BANK_NAME_END = /\s+(?:mobilink|microfinance|easypaisa|jazzcash|bank\b|ltd\b|iban\b|ac\b|a\/c\b|in your|via|from your|on \d|pk[0-9*#])/i;

/** Which of his banks a notification is from: the app's label, or an SMS sender. '' when none. */
function bankOf(app, title) {
  var t = String(title == null ? '' : title).trim();
  if (BANK_SMS_SENDERS[t]) return BANK_SMS_SENDERS[t];
  var a = String(app == null ? '' : app).toLowerCase().replace(/[^a-z]/g, '');
  for (var i = 0; i < BANK_APPS.length; i++) if (a.indexOf(BANK_APPS[i][0]) !== -1) return BANK_APPS[i][1];
  return '';
}

/** "1,250.50" -> 1250.5; NaN unless a positive number. */
function bankAmount(s) {
  var n = Number(String(s == null ? '' : s).replace(/,/g, ''));
  return n > 0 && isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/** The other party's name, tidied: up to the bank or account words after it. */
function bankParty(s) {
  var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  var m = BANK_NAME_END.exec(' ' + t);
  if (m) t = (' ' + t).slice(0, m.index).trim();
  t = t.replace(/[\s,.:;/-]+$/, '');
  return t.length > BANK_PARTY_MAX ? t.slice(0, BANK_PARTY_MAX) : t;
}

/** One notification -> {bank, dir, amount, party} or null. */
function bankParse(n) {
  var bank = bankOf(n && n.app, n && n.title);
  if (!bank) return null;
  var text = String((n && n.text) || '').replace(/\s+/g, ' ');
  var AMT = '(?:Rs\\.?|PKR)\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';
  var forms = [
    // Easypaisa: "An amount of Rs. 1.0 has been successfully sent to SAAD ADA via Raast Payment from your ..."
    [new RegExp('amount of ' + AMT + ' has been (?:successfully )?sent to (.+?)(?: via | from your |$)', 'i'), 'out'],
    // Easypaisa: "You have received Rs.1 in your Easypaisa account ...9002 from Saad Ada PK**... via Raast"
    [new RegExp('received ' + AMT + ' in your .*? from (.+?)(?: via |$)', 'i'), 'in'],
    // JazzCash: "Rs 1 received from Saad Ada AC ****... in your JazzCash Mobile Account"; HBL SMS: "PKR 1.00 received from SAD JAMEEL IBAN in your HBL A/C"
    [new RegExp(AMT + ' received from (.+?)(?: in your |$)', 'i'), 'in'],
    // HBL: "PKR 1 sent to SAD JAMEEL easypaisa Bank Limited from your HBL A/C *9599 on ..."
    [new RegExp(AMT + ' (?:sent|transferred|paid) to (.+?)(?: from your | on \\d|$)', 'i'), 'out'],
    // Anything else that says plainly which way it went.
    [new RegExp(AMT + ' (?:has been |was )?(?:credited|deposited)', 'i'), 'in'],
    [new RegExp(AMT + ' (?:has been |was )?(?:debited|withdrawn)', 'i'), 'out']
  ];
  for (var i = 0; i < forms.length; i++) {
    var m = forms[i][0].exec(text);
    if (!m) continue;
    var amount = bankAmount(m[1]);
    if (!(amount > 0)) return null;
    return { bank: bank, dir: forms[i][1], amount: amount, party: bankParty(m[2] || '') };
  }
  return null;
}

/** Item 40: the phone's blanking, as the server can check it: every run of 7+ digits gone. */
function bankBlank(s) {
  return String(s == null ? '' : s).replace(/[0-9]{7,}/g, '#');
}

var BANK_SAME_MS = 3 * 60000;          // one payment seen twice (HBL's app alert and its SMS)
var BANK_PAIR_MS = 30 * 60000;         // an out and an in between his own accounts
var BANK_AUTO_MS = 7 * 86400000;       // Saad: an entry waits at least 7 days, then is filed by itself

/** Is `a` the same payment as one already kept (another notification of it)? alerts: [{bank, dir, amount, at}]. */
function bankSeen(a, alerts) {
  return (alerts || []).some(function (x) {
    return x.bank === a.bank && x.dir === a.dir && x.amount === a.amount && Math.abs(x.at - a.at) <= BANK_SAME_MS;
  });
}

/** The unpaired alert `a` makes an own transfer with: the other way, another bank, the same amount, within
 *  BANK_PAIR_MS, the nearest in time. null when none. */
function bankPairFor(a, alerts) {
  var best = null;
  (alerts || []).forEach(function (x) {
    if (x.id === a.id || x.pair_id || x.state !== 'pending' || x.dir === a.dir || x.bank === a.bank || x.amount !== a.amount) return;
    if (Math.abs(x.at - a.at) > BANK_PAIR_MS) return;
    if (!best || Math.abs(x.at - a.at) < Math.abs(best.at - a.at)) best = x;
  });
  return best;
}

if (typeof globalThis !== 'undefined') {
  globalThis.ProBeingBank = {
    bankOf: bankOf, bankAmount: bankAmount, bankParty: bankParty, bankParse: bankParse, bankBlank: bankBlank,
    bankSeen: bankSeen, bankPairFor: bankPairFor,
    BANK_SAME_MS: BANK_SAME_MS, BANK_PAIR_MS: BANK_PAIR_MS, BANK_AUTO_MS: BANK_AUTO_MS
  };
}
