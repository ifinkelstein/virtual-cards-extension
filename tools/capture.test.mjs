// Exercises content/capture.js against sample screens, since shape-matching page text
// is the most fragile part of the extension. Uses published test card numbers only.
//
// Run: node tools/capture.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'capture.js'), 'utf8');

// Runs capture.js in a stubbed page and returns whatever it tried to send.
function run({ innerText, pathname = '/vc/virtual-cards/manager/manage' }) {
  const sent = [];
  const context = {
    document: { documentElement: {}, body: { innerText } },
    location: { pathname },
    chrome: { runtime: { sendMessage: async message => void sent.push(message) } },
    MutationObserver: class {
      observe() {}
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInContext(source, vm.createContext(context));
  return sent;
}

// Stands in for the rest of a page: enough text to put something out of reach of the card.
const FILLER = 'Rewards and recent activity for your account. '.repeat(6);

const cases = [
  {
    name: 'reveal screen, all on one line',
    input: { innerText: 'Virtual card number 4111 1111 1111 1111 Expiration 07/29 Security code 737' },
    expect: { number: '4111111111111111', expiry: '07/29', cvv: '737' },
  },
  {
    name: 'number split across elements, one per line',
    input: { innerText: 'Card number\n4111\n1111\n1111\n1111\nExpires\n07/29\nCVV\n737' },
    expect: { number: '4111111111111111', expiry: '07/29', cvv: '737' },
  },
  {
    name: 'create confirmation screen',
    input: { innerText: 'Virtual card created 5555 5555 5555 4444 Exp 12/28 Security code 123', pathname: '/vc/create-virtual-card' },
    expect: { number: '5555555555554444', expiry: '12/28', cvv: '123' },
  },
  {
    name: 'fifteen-digit card',
    input: { innerText: 'Card 3782 822463 10005 Expiration 01/30 Security code 1234' },
    expect: { number: '378282246310005', expiry: '01/30', cvv: '1234' },
  },
  {
    name: 'masked card sends nothing',
    input: { innerText: 'Virtual card •••• •••• •••• 1234 Expiration 07/29' },
    expect: null,
  },
  {
    name: 'card list page sends nothing even with a number present',
    input: { innerText: '4111 1111 1111 1111', pathname: '/vc/virtual-cards/manager' },
    expect: null,
  },
  {
    name: 'digits that fail the checksum send nothing',
    input: { innerText: 'Reference 1234 5678 9012 3456 Expiration 07/29' },
    expect: null,
  },
  {
    name: 'date just before the card does not beat the expiry after it',
    input: { innerText: 'Last used 09/26 Virtual card number 4111 1111 1111 1111 Expiration 07/29 Security code 737' },
    expect: { number: '4111111111111111', expiry: '07/29', cvv: '737' },
  },
  {
    name: 'date far from the card is not taken as its expiry',
    input: { innerText: `Virtual card number 4111 1111 1111 1111 Security code 737 ${FILLER} Offer ends 09/26` },
    expect: { number: '4111111111111111', expiry: '', cvv: '737' },
  },
  {
    name: 'checksum-valid number elsewhere on the page does not beat the card',
    input: { innerText: `Reference 4012 8888 8888 1881 ${FILLER} Virtual card number 4111 1111 1111 1111 Expiration 07/29 Security code 737` },
    expect: { number: '4111111111111111', expiry: '07/29', cvv: '737' },
  },
  {
    name: "one number never takes the next number's expiry",
    input: { innerText: 'Reference 4012 8888 8888 1881 Virtual card number 5555 5555 5555 4444 Exp 12/28 Security code 123' },
    expect: { number: '5555555555554444', expiry: '12/28', cvv: '123' },
  },
  {
    name: 'two numbers with no expiry near either send nothing',
    input: { innerText: 'Reference 4012 8888 8888 1881 Card 4111 1111 1111 1111' },
    expect: null,
  },
];

for (const { name, input, expect } of cases) {
  test(name, () => {
    const [message] = run(input);
    // Spread into this realm: the payload's prototype is the sandbox's own Object, which
    // a strict deepEqual would count as a difference. Sample data, so printing it is fine.
    const got = message ? { ...message.payload } : null;
    assert.deepEqual(got, expect);
  });
}

test('create screen pre-fills card name and clicks create button when pending', async () => {
  const nameInput = {
    tagName: 'INPUT',
    type: 'text',
    name: 'cardNickname',
    placeholder: 'Name your virtual card',
    value: '',
  };
  let clicked = false;
  const createBtn = {
    tagName: 'BUTTON',
    textContent: 'Create Virtual Card',
    click() {
      clicked = true;
    },
  };
  const context = {
    document: {
      documentElement: {},
      body: { innerText: 'Create a virtual card' },
      querySelectorAll(selector) {
        if (selector === 'input') return [nameInput];
        if (selector.includes('button')) return [createBtn];
        return [];
      },
    },
    location: { pathname: '/vc/create-virtual-card' },
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (message.type === 'GET_PENDING_CREATE') return { name: 'newegg.com', autoSubmit: true };
          return null;
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout: fn => fn(),
    clearTimeout,
  };
  vm.runInContext(source, vm.createContext(context));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nameInput.value, 'newegg.com');
  assert.equal(clicked, true);
});

test('create screen aborts auto-fill and auto-submit when 2FA step-up is on screen', async () => {
  const otpInput = {
    tagName: 'INPUT',
    type: 'text',
    name: 'otpCode',
    placeholder: 'Enter 6-digit code',
    value: '',
    getAttribute: k => (k === 'autocomplete' ? 'one-time-code' : null),
  };
  let clicked = false;
  const continueBtn = {
    tagName: 'BUTTON',
    textContent: 'Continue',
    click() {
      clicked = true;
    },
  };
  const context = {
    document: {
      documentElement: {},
      body: { innerText: 'Verify your identity. Enter the 6-digit verification code we texted you.' },
      querySelectorAll(selector) {
        if (selector === 'input') return [otpInput];
        if (selector.includes('button')) return [continueBtn];
        return [];
      },
    },
    location: { pathname: '/vc/create-virtual-card' },
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (message.type === 'GET_PENDING_CREATE') return { name: 'newegg.com', autoSubmit: true };
          return null;
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout: fn => fn(),
    clearTimeout,
  };
  vm.runInContext(source, vm.createContext(context));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(otpInput.value, '');
  assert.equal(clicked, false);
});

test('create screen traverses open shadow roots and waits for input event to enable submit', async () => {
  let trackedValue = '';
  let clicked = false;
  const createBtn = {
    tagName: 'BUTTON',
    textContent: 'Create Virtual Card',
    disabled: true,
    click() {
      if (!this.disabled) clicked = true;
    },
  };
  const shadowInput = {
    tagName: 'INPUT',
    type: 'text',
    name: 'nickname',
    placeholder: 'Virtual card name',
    value: '',
    _valueTracker: {
      setValue(v) {
        trackedValue = v;
      },
    },
    dispatchEvent(ev) {
      if (ev.type === 'input' && trackedValue !== this.value && this.value === 'heb.com') {
        createBtn.disabled = false;
      }
    },
  };
  const customHost = {
    shadowRoot: {
      querySelectorAll(selector) {
        if (selector === 'input') return [shadowInput];
        if (selector.includes('button')) return [createBtn];
        return [];
      },
    },
  };
  const context = {
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      documentElement: {},
      body: { innerText: 'Create a virtual card' },
      querySelectorAll(selector) {
        if (selector === '*') return [customHost];
        return [];
      },
    },
    location: { pathname: '/vc/create-virtual-card' },
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (message.type === 'GET_PENDING_CREATE') return { name: 'heb.com', autoSubmit: true };
          return null;
        },
      },
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout: fn => fn(),
    clearTimeout,
  };
  vm.runInContext(source, vm.createContext(context));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shadowInput.value, 'heb.com');
  assert.equal(createBtn.disabled, false);
  assert.equal(clicked, true);
});

const autofillSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'autofill.js'), 'utf8');

test('autofill.js fills standard checkout inputs and split month/year selects', () => {
  const numInput = { tagName: 'INPUT', type: 'text', name: 'cardnumber', value: '', getAttribute: k => (k === 'autocomplete' ? 'cc-number' : null) };
  const monthSelect = {
    tagName: 'SELECT',
    name: 'expMonth',
    value: '',
    getAttribute: k => (k === 'autocomplete' ? 'cc-exp-month' : null),
    options: [
      { value: '01', textContent: '01 - Jan' },
      { value: '07', textContent: '07 - Jul' },
    ],
  };
  const yearSelect = {
    tagName: 'SELECT',
    name: 'expYear',
    value: '',
    getAttribute: k => (k === 'autocomplete' ? 'cc-exp-year' : null),
    options: [
      { value: '2028', textContent: '2028' },
      { value: '2029', textContent: '2029' },
    ],
  };
  const cvvInput = { tagName: 'INPUT', type: 'tel', name: 'cvc', value: '', getAttribute: k => (k === 'autocomplete' ? 'cc-csc' : null) };

  const context = {
    document: {
      querySelectorAll: () => [numInput, monthSelect, yearSelect, cvvInput],
    },
  };
  vm.runInContext(autofillSource, vm.createContext(context));
  const res = context.vchAutofillCard({ number: '4111111111111111', expiry: '07/29', cvv: '737' });
  assert.deepEqual([...res.filled], ['number', 'expiry', 'cvv']);
  assert.equal(numInput.value, '4111111111111111');
  assert.equal(monthSelect.value, '07');
  assert.equal(yearSelect.value, '2029');
  assert.equal(cvvInput.value, '737');
});

test('autofill.js handles React _valueTracker, strict PAN/expiry masks, and ignores non-card fields', () => {
  const holderInput = { tagName: 'INPUT', type: 'text', name: 'cardholderName', value: '', getAttribute: k => (k === 'autocomplete' ? 'cc-name' : null) };
  const zipInput = { tagName: 'INPUT', type: 'text', name: 'billingZip', value: '', getAttribute: k => (k === 'autocomplete' ? 'postal-code' : null) };
  const promoInput = { tagName: 'INPUT', type: 'text', name: 'promoCode', placeholder: 'Promo or gift card code', value: '', getAttribute: () => null };

  // Simulates a strict grouped PAN mask that rejects unspaced 16-digit input.
  let reactPanState = '';
  let panTracked = '';
  const maskedPanInput = {
    tagName: 'INPUT',
    type: 'text',
    name: 'card_number',
    placeholder: '4111 1111 1111 1111',
    maxLength: 19,
    value: '',
    getAttribute: () => null,
    _valueTracker: {
      setValue(v) {
        panTracked = v;
      },
    },
    dispatchEvent(ev) {
      if (ev.type === 'input') {
        if (!/^\d{4} \d{4} \d{4} \d{4}$/.test(this.value)) {
          this.value = '';
          return;
        }
        if (panTracked !== this.value) reactPanState = this.value;
      }
    },
  };

  // Simulates an expiry mask that inserts its own slash and corrupts "07/29",
  // expecting raw digits "0729" which it formats to "07/29".
  const maskedExpiryInput = {
    tagName: 'INPUT',
    type: 'text',
    name: 'cc_exp',
    placeholder: 'MM/YY',
    maxLength: 5,
    value: '',
    getAttribute: () => null,
    dispatchEvent(ev) {
      if (ev.type === 'input') {
        if (this.value === '07/29') this.value = '07-bad';
        else if (this.value === '0729') this.value = '07/29';
      }
    },
  };

  const context = {
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      querySelectorAll: () => [holderInput, zipInput, promoInput, maskedPanInput, maskedExpiryInput],
    },
  };
  vm.runInContext(autofillSource, vm.createContext(context));
  const res = context.vchAutofillCard({ number: '4111111111111111', expiry: '07/29', cvv: '737' });
  assert.deepEqual([...res.filled], ['number', 'expiry']);
  assert.equal(reactPanState, '4111 1111 1111 1111');
  assert.equal(maskedExpiryInput.value, '07/29');
  assert.equal(holderInput.value, '');
  assert.equal(zipInput.value, '');
  assert.equal(promoInput.value, '');
});

const panelSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sidepanel', 'panel.js'), 'utf8');

test('panel.js preserves Firefox container cookieStoreId and ignores initial about:blank complete event', async () => {
  const createdTabs = [];
  const updatedListeners = [];
  const removedListeners = [];
  let signedOutTabs = [{ id: 10, url: 'https://verified.capitalone.com/auth/signin', cookieStoreId: 'firefox-container-3' }];
  let c1Tabs = [];

  const stubEl = () => ({
    hidden: false,
    value: '',
    checked: true,
    textContent: '',
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    options: [],
    replaceChildren() {},
    append() {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  });

  const context = {
    URL,
    Option: class {
      constructor(text, value) {
        this.textContent = text;
        this.value = value;
      }
    },
    document: {
      getElementById: () => stubEl(),
      createElement: () => stubEl(),
      addEventListener() {},
    },
    chrome: {
      storage: {
        local: {
          get: async key => (key === 'noticeAccepted' ? { noticeAccepted: 1 } : {}),
          set: async () => {},
        },
        onChanged: { addListener() {} },
      },
      runtime: { onMessage: { addListener() {} } },
      windows: { update: async () => {} },
      scripting: { executeScript: async () => [] },
      tabs: {
        query: async ({ url }) => {
          if (url === 'https://myaccounts.capitalone.com/*') return c1Tabs;
          if (Array.isArray(url)) return signedOutTabs;
          return [];
        },
        get: async id => c1Tabs.find(t => t.id === id) ?? { id, status: 'loading', url: 'about:blank' },
        create: async opts => {
          createdTabs.push(opts);
          const created = { id: 42, status: 'loading', url: 'about:blank', ...opts };
          setImmediate(() => {
            // 1. Firefox emits status: 'complete' for about:blank first
            for (const fn of [...updatedListeners]) fn(42, { status: 'complete' }, { id: 42, status: 'complete', url: 'about:blank' });
            // 2. Then finishes loading on myaccounts.capitalone.com
            const loaded = { id: 42, status: 'complete', url: 'https://myaccounts.capitalone.com/accountSummary', cookieStoreId: opts.cookieStoreId };
            c1Tabs = [loaded];
            for (const fn of [...updatedListeners]) fn(42, { status: 'complete', url: loaded.url }, loaded);
          });
          return created;
        },
        update: async () => {},
        sendMessage: async (_tabId, msg) => {
          if (msg.type === 'accounts') return { ok: true, data: [{ arid: 'A1', productName: 'Venture', lastFour: '1234' }] };
          if (msg.type === 'ping') return { ok: true, data: { arid: 'A1' } };
          if (msg.type === 'cardholders') return { ok: true, data: [] };
          if (msg.type === 'list') return { ok: true, data: { total: 0, cards: [] } };
          return { ok: true, data: {} };
        },
        onRemoved: { addListener: fn => removedListeners.push(fn) },
        onUpdated: {
          addListener: fn => updatedListeners.push(fn),
          removeListener: fn => {
            const idx = updatedListeners.indexOf(fn);
            if (idx !== -1) updatedListeners.splice(idx, 1);
          },
        },
        onActivated: { addListener() {} },
      },
    },
    console: { warn() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval,
    requestAnimationFrame: () => 1,
  };

  // First run learns cookieStoreId = 'firefox-container-3' from the signed-out tab, then closing
  // that tab and calling reload() opens a new background tab in that same container.
  const sandbox = vm.createContext(context);
  vm.runInContext(panelSource, sandbox);
  await new Promise(resolve => setTimeout(resolve, 20));
  signedOutTabs = [];
  for (const fn of removedListeners) fn(10);
  await sandbox.reload();

  assert.equal(createdTabs.length, 1);
  assert.equal(createdTabs[0].cookieStoreId, 'firefox-container-3');
  assert.equal(createdTabs[0].active, false);
});


