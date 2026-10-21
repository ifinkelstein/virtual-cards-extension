// Reads card details off Capital One's own reveal and create-confirmation screens,
// and pre-fills / submits the card nickname on the create screen when asked by the panel.
// The page decrypts card details; this only reads what is already rendered, matched by
// shape rather than by CSS selector so their markup can change without breaking it.
//
// Nothing is kept or logged here. Details go straight to the side panel, which holds
// them in memory only. The de-duplication fingerprint deliberately uses the last four
// digits rather than the whole number.
(() => {
  const ROUTES = /\/vc\/(?:virtual-cards\/manager\/manage|create-virtual-card)/;
  const CREATE_ROUTE = /\/vc\/create-virtual-card/;
  const PAN = /(?:\d[ -]?){12,18}\d/g;
  const EXPIRY = /\b(?:0[1-9]|1[0-2])\s*\/\s*\d{2}(?:\d{2})?\b/g;
  const LABELLED_CVV = /(?:security code|cvv|cvc|cvn|card code)\D{0,24}?(\d{3,4})\b/gi;
  const NAME_FIELD = /\b(?:card\s*name|virtual\s*card\s*name|nickname|merchant|name\s*your\s*card|card\s*label|name)\b/i;
  const CREATE_BUTTON = /^(?:create(?:\s+virtual)?(?:\s+card)?|get(?:\s+virtual)?\s+card|continue|generate(?:\s+card)?|submit)$/i;
  const STEP_UP_TEXT = /\b(?:verification\s+code|temporary\s+code|6-digit\s+code|text\s+you\s+a\s+code|verify\s+it'?s\s+you|verify\s+your\s+identity|two-step\s+verification|enter\s+the\s+code|send\s+me\s+a\s+code)\b/i;
  const STEP_UP_INPUT = /\b(?:one-time-code|otp|passcode|verification[-_\s]*code|security[-_\s]*code|temporary[-_\s]*code)\b/i;
  // How far from the number an expiry or security code may start, in characters of page
  // text. Room for labels and Copy buttons between them, but not for a date somewhere
  // else on the page. They usually follow the number, so less is allowed before it.
  const NEAR_AFTER = 160;
  const NEAR_BEFORE = 80;
  const SCAN_DELAY_MS = 300;
  const SUBMIT_DELAY_MS = 150;

  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    return sum % 10 === 0;
  }

  // The match for pattern nearest the number, after it first, then before it. The range
  // stops at any neighbouring number, so one number never takes another's details.
  function near(text, pattern, card) {
    pattern.lastIndex = card.end;
    const after = pattern.exec(text);
    if (after && after.index < Math.min(card.end + NEAR_AFTER, card.next)) return after;

    let before = null;
    pattern.lastIndex = Math.max(card.start - NEAR_BEFORE, card.previous);
    let match = pattern.exec(text);
    while (match && match.index + match[0].length <= card.start) {
      before = match;
      match = pattern.exec(text);
    }
    return before;
  }

  function findDetails() {
    // innerText rather than textContent: it reflects what is actually visible, so
    // masked placeholders and offscreen templates do not match. Whitespace is flattened
    // because the number is often four separate elements.
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
    if (!text) return null;

    const cards = [];
    for (const match of text.matchAll(PAN)) {
      const digits = match[0].replace(/\D/g, '');
      if (digits.length >= 15 && digits.length <= 16 && luhn(digits)) {
        cards.push({ number: digits, start: match.index, end: match.index + match[0].length });
      }
    }
    cards.forEach((card, i) => {
      card.previous = cards[i - 1]?.end ?? 0;
      card.next = cards[i + 1]?.start ?? text.length;
    });

    // About one in ten random 16-digit numbers passes the checksum, so the card is the one
    // with an expiry beside it. A lone number with none nearby is still sent, with the
    // expiry left blank rather than borrowed from elsewhere on the page.
    const card = cards.find(c => near(text, EXPIRY, c)) ?? (cards.length === 1 ? cards[0] : null);
    if (!card) return null;

    return {
      number: card.number,
      expiry: (near(text, EXPIRY, card)?.[0] ?? '').replace(/\s/g, ''),
      cvv: near(text, LABELLED_CVV, card)?.[1] ?? '',
    };
  }

  function queryAllDeep(selector, root = document) {
    if (typeof root?.querySelectorAll !== 'function') return [];
    const results = [...root.querySelectorAll(selector)];
    const all = root.querySelectorAll('*');
    if (Array.isArray(all) || typeof all?.[Symbol.iterator] === 'function') {
      for (const node of all) {
        if (node?.shadowRoot) results.push(...queryAllDeep(selector, node.shadowRoot));
      }
    }
    return results;
  }

  function isVisible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.closest?.('[hidden], [aria-hidden="true"]')) return false;
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  }

  function inputHint(el) {
    const labels = el.labels ? [...el.labels].map(l => l.textContent ?? '') : [];
    const parentLabel = el.closest?.('label')?.textContent ?? '';
    return [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute?.('autocomplete'),
      el.getAttribute?.('aria-label'),
      ...labels,
      parentLabel,
    ]
      .filter(Boolean)
      .join(' ');
  }

  // Never touch inputs or buttons if Capital One is asking for 2FA step-up verification.
  function isStepUpScreen() {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
    if (STEP_UP_TEXT.test(text)) return true;
    const inputs = queryAllDeep('input').filter(isVisible);
    return inputs.some(el => STEP_UP_INPUT.test(inputHint(el)));
  }

  function setInputValue(el, value) {
    const previous = el.value ?? '';
    el.focus?.();
    const proto = globalThis.HTMLInputElement?.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (setter) setter.call(el, value);
    else el.value = value;
    el._valueTracker?.setValue?.(previous);
    if (typeof InputEvent === 'function') {
      el.dispatchEvent?.(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
      el.dispatchEvent?.(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
    } else if (typeof Event === 'function') {
      el.dispatchEvent?.(new Event('input', { bubbles: true, cancelable: true }));
    }
    if (typeof Event === 'function') {
      el.dispatchEvent?.(new Event('change', { bubbles: true, cancelable: true }));
      el.dispatchEvent?.(new Event('blur', { bubbles: true }));
    }
  }

  let lastPath = location.pathname;
  let lastSeen = '';
  let createAsked = false;
  let pendingCreate = null;
  let createFilled = false;
  let createNameInput = null;
  let createSubmitted = false;

  function resetCreateState() {
    createAsked = false;
    pendingCreate = null;
    createFilled = false;
    createNameInput = null;
    createSubmitted = false;
  }

  function tryAutoCreate() {
    if (!pendingCreate?.name || typeof document.querySelectorAll !== 'function') return;
    if (isStepUpScreen()) return;

    if (!createFilled) {
      const inputs = queryAllDeep('input').filter(el => {
        if (!isVisible(el)) return false;
        const type = (el.type ?? 'text').toLowerCase();
        const hint = inputHint(el);
        return (type === '' || type === 'text') && !/\bsearch\b/i.test(hint) && !STEP_UP_INPUT.test(hint);
      });
      const target = inputs.find(el => NAME_FIELD.test(inputHint(el))) ?? (inputs.length === 1 ? inputs[0] : null);
      if (!target) return;

      setInputValue(target, pendingCreate.name);
      createNameInput = target;
      createFilled = true;
      if (pendingCreate.autoSubmit) setTimeout(tryAutoCreate, SUBMIT_DELAY_MS);
      return;
    }

    if (pendingCreate.autoSubmit && !createSubmitted) {
      // Only click submit if the nickname input still holds the merchant name we set.
      if (createNameInput && String(createNameInput.value ?? '').trim() !== pendingCreate.name) {
        return;
      }
      const buttons = queryAllDeep('button, input[type="submit"]').filter(el => {
        if (!isVisible(el)) return false;
        return el.getAttribute?.('aria-disabled') !== 'true';
      });
      const submit = buttons.find(el => {
        const label = (el.textContent || el.value || el.getAttribute?.('aria-label') || '').trim();
        return CREATE_BUTTON.test(label);
      }) ?? buttons.find(el => (el.type ?? '').toLowerCase() === 'submit');
      if (!submit) return;

      createSubmitted = true;
      submit.click?.();
    }
  }

  function scan() {
    if (!ROUTES.test(location.pathname)) return;
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      lastSeen = '';
      resetCreateState();
    }

    const details = findDetails();
    if (!details) {
      if (CREATE_ROUTE.test(location.pathname) && typeof document.querySelectorAll === 'function') {
        if (!createAsked) {
          createAsked = true;
          chrome.runtime
            .sendMessage({ type: 'GET_PENDING_CREATE' })
            .then(plan => {
              if (plan?.name) {
                pendingCreate = plan;
                tryAutoCreate();
              }
            })
            .catch(() => {});
        } else if (pendingCreate && !createSubmitted) {
          tryAutoCreate();
        }
      }
      return;
    }

    const fingerprint = `${details.number.slice(-4)}|${details.expiry}`;
    if (fingerprint === lastSeen) return;
    lastSeen = fingerprint;

    chrome.runtime
      .sendMessage({ type: 'CARD_DETAILS', payload: details })
      .catch(() => {}); // nothing listening means the side panel is closed
  }

  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, SCAN_DELAY_MS);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  scan();
})();
