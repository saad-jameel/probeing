/* Item 40: bank alerts read off the phone's notifications. A classic script, like day.js:
 * activity-ingest imports it and the node tests load it. No import/export; strict-mode safe.
 *
 * The phone sends {app, title, text, at, key}: the notification's own app label and title, its text with every
 * run of 7+ digits blanked (account, phone and transaction numbers), the post time and a hash for dedupe.
 * bankParse turns one into {bank, dir, amount, party}, or null when it is not a payment it can read. */

var BANK_PARTY_MAX = 60;
// An SMS alert, by its sender (the notification's title). Item 45: Easypaisa 3737, JazzCash 8558 (Saad, 7 Nov).
var BANK_SMS_SENDERS = { '14250': 'HBL', '4250': 'HBL', '3737': 'Easypaisa', '8558': 'JazzCash' };
var BANK_APPS = [['hbl', 'HBL'], ['easypaisa', 'Easypaisa'], ['jazzcash', 'JazzCash']];
// Words that end a name: the bank the money went to or came from, or the account phrase after it.
var BANK_NAME_END = /\s+(?:mobilink|microfinance|easypaisa|jazzcash|bank\b|ltd\b|iban\b|ac\b|a\/c\b|in your|via|from your|on \d|pk[0-9*#]|with\b|of iban|till id|fee\b|\()/i;
var BANK_TEXT_KEEP = 500;              // item 45: an alert it cannot read keeps this much of its (blanked) text

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

/** Item 45: 'sms' when the alert came as a text (its title is a bank's sender), else 'app'. */
function bankSource(app, title) {
  return BANK_SMS_SENDERS[String(title == null ? '' : title).trim()] ? 'sms' : 'app';
}

var BANK_AMT = '(?:Rs\\.?|PKR)\\s*:?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';
/* Item 45 (Saad, 7 Nov: "very critical, be sure"): a payment is an amount plus a past-tense money word.
 * A promotion ("Rs.99 rewards", "1 Crore jeetein") has no such word; these are never payments either. */
var BANK_OUT_WORDS = /\b(?:sent|debited|paid|charged|transferred|withdrawn|withdrawl|withdrawal)\b/i;
var BANK_IN_WORDS = /\b(?:received|credited|deposited|refunded|reversed)\b/i;
var BANK_NOT_PAID = /\b(?:otp|one[- ]time (?:password|pin)|verification code|failed|declined|unsuccessful|rejected|could not|insufficient|will be)\b/i;
// The bank's own transaction number, by its name only (the number itself is blanked on the phone): "Tx ID",
// "TID", "Trx ID", "TXN ID", "Transaction ID". Saad's best clue that a message is a real payment.
var BANK_ID_WORD = /\b(?:tx|trx|txn|t)\s*\.?\s*id\b|\btransaction\s+id\b/i;

/** The first amount that is not a balance or a fee ("Avail Bal: PKR 87,100", "Fee: Rs 0.00"). */
function bankFirstAmount(text) {
  var re = new RegExp(BANK_AMT, 'gi');
  var m;
  while ((m = re.exec(text))) {
    var before = text.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:bal(?:ance)?|fee|charges?)\W*(?:is\W*)?$/i.test(before)) continue;
    var n = bankAmount(m[1]);
    if (n > 0) return n;
  }
  return NaN;
}

/** One notification -> {bank, dir, amount, party, how} (how: 'card', 'atm', 'qr' or ''), or {bank, unread: true}
 *  when it looks like a payment it cannot read (Saad fills it in), or null when it is not a payment. */
function bankParse(n) {
  var bank = bankOf(n && n.app, n && n.title);
  if (!bank) return null;
  var text = String((n && n.text) || '').replace(/\s+/g, ' ');
  if (BANK_NOT_PAID.test(text) && !/\b(?:reversed|refunded)\b/i.test(text)) return null;   // a failed payment given back is money in
  var AMT = BANK_AMT;
  var how = /\bATM\b/i.test(text) ? 'atm' : /via QR|QR code|till id/i.test(text) ? 'qr' : /debit card|\bcard\b/i.test(text) ? 'card' : '';
  var forms = [
    // HBL card: "...has been Debited with PKR 2,500.00 on 07/11/2026 16:40 at IMTIAZ STORE via Debit Card."
    [new RegExp('debited with ' + AMT + '.*? at ([^0-9].*?)(?: via |\\. |$)', 'i'), 'out'],
    // HBL card: "Your HBL Debit Card has been charged for a Transaction of PKR 2,500 on <date> (at X)"
    [new RegExp('charged for a transaction of ' + AMT + '(?:.*? at ([^0-9].*?)(?: on \\d|\\. |$))?', 'i'), 'out'],
    // HBL ATM: "...has been debited with PKR 5,000 on <date> for ATM Cash Withdrawl"
    [new RegExp('debited with ' + AMT, 'i'), 'out'],
    // Easypaisa: "An amount of Rs. 1.0 has been successfully sent to SAAD ADA via Raast Payment from your ..."
    // JazzCash 8558: "Dear X, an amount of Rs. 2 has been successfully sent to SAD JAMEEL of IBAN No: ****8867 on ..."
    [new RegExp('amount of ' + AMT + ' has been (?:successfully )?sent to (.+?)(?: via | from your | of iban| on \\d|$)', 'i'), 'out'],
    // Easypaisa: "You have received Rs.1 in your Easypaisa account ...9002 from Saad Ada PK**... via Raast"
    [new RegExp('received ' + AMT + ' in your .*? from (.+?)(?: via |$)', 'i'), 'in'],
    // Easypaisa to Easypaisa: "You have Received Rs 4768.00 from BILAL UBAID with Easypaisa Account 923319****98."
    [new RegExp('received ' + AMT + ' from (.+?)(?: with | via | in your |\\. |$)', 'i'), 'in'],
    // JazzCash: "Rs 1 received from Saad Ada AC ****... in your JazzCash Mobile Account"; HBL SMS: "PKR 1.00 received from SAD JAMEEL IBAN in your HBL A/C"
    [new RegExp(AMT + ' received from (.+?)(?: in your |$)', 'i'), 'in'],
    // HBL: "PKR 1 sent to SAD JAMEEL easypaisa Bank Limited from your HBL A/C *9599 on ..."; JazzCash card / QR:
    // "Rs 500 paid to KFC on <date> Fee: Rs 0 TID # via JazzCash Debit Card", "Rs. 500 paid to X till ID # on <date> ... via QR Code"
    [new RegExp(AMT + ' (?:has been )?(?:sent|transferred|paid) to (.+?)(?: from your | on \\d| till id| fee|$)', 'i'), 'out']
  ];
  for (var i = 0; i < forms.length; i++) {
    var m = forms[i][0].exec(text);
    if (!m) continue;
    var amount = bankAmount(m[1]);
    if (!(amount > 0)) break;
    return { bank: bank, dir: forms[i][1], amount: amount, party: how === 'atm' ? '' : bankParty(m[2] || ''), how: how };
  }
  // Any other wording: an amount and exactly one way's money word. Both ways, or a transaction number with
  // no amount or no word: a payment it cannot read, for him to fill in.
  var out = BANK_OUT_WORDS.test(text);
  var into = BANK_IN_WORDS.test(text);
  var amt = bankFirstAmount(text);
  if (amt > 0 && out !== into) return { bank: bank, dir: out ? 'out' : 'in', amount: amt, party: '', how: how };
  if ((amt > 0 && out && into) || BANK_ID_WORD.test(text)) return { bank: bank, unread: true };
  return null;
}

/** Item 40: the phone's blanking, as the server can check it: every run of 7+ digits gone. */
function bankBlank(s) {
  return String(s == null ? '' : s).replace(/[0-9]{7,}/g, '#');
}

var BANK_SAME_MS = 3 * 60000;          // one payment seen twice (HBL's app alert and its SMS)
var BANK_PAIR_MS = 30 * 60000;         // an out and an in between his own accounts
var BANK_AUTO_MS = 7 * 86400000;       // Saad: an entry waits at least 7 days, then is filed by itself

/** Is `a` the same payment as one already kept (another notification of it)? alerts: [{bank, dir, amount, at,
 *  source}]. Item 45: only an app alert and a text can be one payment; two app alerts are two payments
 *  (Saad's two Rs 5 from HBL two minutes apart, 7 Nov). */
function bankSeen(a, alerts) {
  var src = a.source || 'app';
  return (alerts || []).some(function (x) {
    return x.bank === a.bank && x.dir === a.dir && x.amount === a.amount && (x.source || 'app') !== src &&
           Math.abs(x.at - a.at) <= BANK_SAME_MS;
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
    bankSeen: bankSeen, bankPairFor: bankPairFor, bankSource: bankSource, BANK_TEXT_KEEP: BANK_TEXT_KEEP,
    BANK_SAME_MS: BANK_SAME_MS, BANK_PAIR_MS: BANK_PAIR_MS, BANK_AUTO_MS: BANK_AUTO_MS
  };
}
