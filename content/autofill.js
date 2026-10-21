// Fills credit card fields on the active checkout page when asked by the side panel.
// Injected on demand into the target tab (including payment iframes) when autofilling.
// Never stores, logs, or returns page data — only which field types were filled.
(() => {
  const MONTHS = [
    ['january', 'jan'],
    ['february', 'feb'],
    ['march', 'mar'],
    ['april', 'apr'],
    ['may', 'may'],
    ['june', 'jun'],
    ['july', 'jul'],
    ['august', 'aug'],
    ['september', 'sep', 'sept'],
    ['october', 'oct'],
    ['november', 'nov'],
    ['december', 'dec'],
  ];

  const SKIP_INPUT_TYPES = new Set([
    'hidden', 'submit', 'button', 'reset', 'checkbox', 'radio',
    'file', 'image', 'range', 'color', 'date', 'time', 'datetime-local', 'email', 'url',
  ]);

  // Fields that look numeric or card-related but must never receive PAN, expiry, or CVV.
  const NON_CARD_NAME = /\b(?:cc-name|cc-given-name|cc-additional-name|cc-family-name|cardholder|name\s*on\s*card|holder\s*name|first\s*name|last\s*name|full\s*name|billing\s*name)\b/;
  const NON_CARD_OTHER = /\b(?:postal|zip\s*code|zipcode|zip|promo|coupon|gift\s*card|discount|voucher|routing|iban|ssn|tax\s*id|phone|mobile|quantity|qty|search)\b/;

  function queryAllDeep(selector, root = document) {
    if (typeof root?.querySelectorAll !== 'function') return [];
    const results = [...root.querySelectorAll(selector)];
    const all = typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
    for (const node of all) {
      if (node?.shadowRoot) results.push(...queryAllDeep(selector, node.shadowRoot));
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

  function isCandidateInput(el) {
    if (!isVisible(el)) return false;
    const tag = (el.tagName ?? '').toUpperCase();
    if (tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = (el.type ?? 'text').toLowerCase();
    return !SKIP_INPUT_TYPES.has(type);
  }

  function labelFor(el) {
    const parts = [];
    if (el.labels) {
      for (const label of el.labels) {
        if (label.textContent) parts.push(label.textContent);
      }
    }
    const root = el.getRootNode?.() ?? document;
    if (!parts.length && el.id && typeof root?.querySelectorAll === 'function') {
      for (const label of root.querySelectorAll('label[for]')) {
        if (label.getAttribute('for') === el.id && label.textContent) {
          parts.push(label.textContent);
        }
      }
    }
    const parentLabel = el.closest?.('label');
    if (parentLabel?.textContent) parts.push(parentLabel.textContent);
    return parts.join(' ');
  }

  function hintsFor(el) {
    const auto = (el.getAttribute?.('autocomplete') ?? '').toLowerCase().trim();
    const tokens = new Set(auto.split(/\s+/).filter(Boolean));
    const text = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('data-elements-stable-field-name'),
      el.getAttribute?.('data-fieldtype'),
      el.getAttribute?.('data-current-field'),
      el.getAttribute?.('data-testid'),
      labelFor(el),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return { tokens, text };
  }

  function dispatchInputEvents(el, value) {
    if (typeof InputEvent === 'function') {
      el.dispatchEvent?.(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value,
      }));
    }
    if (typeof InputEvent === 'function') {
      el.dispatchEvent?.(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value,
      }));
    } else if (typeof Event === 'function') {
      el.dispatchEvent?.(new Event('input', { bubbles: true, cancelable: true }));
    }
    if (typeof Event === 'function') {
      el.dispatchEvent?.(new Event('change', { bubbles: true, cancelable: true }));
      el.dispatchEvent?.(new Event('blur', { bubbles: true }));
    }
  }

  // Updates an input or select while notifying React's _valueTracker and input masks.
  function setFieldValue(el, value) {
    const previous = el.value ?? '';
    el.focus?.();
    const tag = (el.tagName ?? '').toUpperCase();
    const proto = tag === 'SELECT'
      ? globalThis.HTMLSelectElement?.prototype
      : globalThis.HTMLInputElement?.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if ( setter ) setter.call(el, value);
    else el.value = value;
    // React 16+ tracks the last known value on _valueTracker and ignores input events
    // if _valueTracker already matches el.value.
    el._valueTracker?.setValue?.(previous);
    dispatchInputEvents(el, value);
  }

  function formatSpacedPan(digits) {
    if (digits.length === 15) {
      return `${digits.slice(0, 4)} ${digits.slice(4, 10)} ${digits.slice(10)}`;
    }
    return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  function fillPanField(el, number) {
    setFieldValue(el, number);
    const currentDigits = String(el.value ?? '').replace(/\D/g, '');
    if (currentDigits === number) return;
    // Some strict input masks reject unspaced input when a grouped mask is active.
    if (!el.maxLength || el.maxLength >= 17) {
      setFieldValue(el, formatSpacedPan(number));
    }
  }

  function selectOption(select, matches) {
    const options = [...(select.options ?? [])];
    for (const check of matches) {
      const found = options.find(opt => !opt.disabled && check(
        String(opt.value ?? '').trim().toLowerCase(),
        String(opt.textContent ?? '').trim().toLowerCase(),
      ));
      if (found) {
        setFieldValue(select, found.value);
        return true;
      }
    }
    return false;
  }

  function isExcluded({ tokens, text }) {
    for (const token of ['cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'postal-code', 'tel', 'email', 'username']) {
      if (tokens.has(token)) return true;
    }
    return NON_CARD_NAME.test(text) || NON_CARD_OTHER.test(text);
  }

  // Aligned with Mozilla FormAutofillHeuristics.sys.mjs credit card rules.
  function isNumberField(el, hints) {
    if ((el.tagName ?? '').toUpperCase() !== 'INPUT') return false;
    const { tokens, text } = hints;
    if (tokens.has('cc-number') || tokens.has('card-number')) return true;
    if (isExcluded(hints)) return false;
    if (/\b(?:cvv2?|cvc2?|csc|cid|security|verification|exp(?:iry|iration)?|month|year)\b/.test(text)) {
      return false;
    }
    if (/\b(?:card[-_\s]*(?:number|num|no|#)|cc[-_\s]*(?:number|num|no|#)|cardnumber|encryptedcardnumber|credit[-_\s]*card|acct[-_\s]*num|pan)\b/.test(text)) {
      return true;
    }
    if ((el.id ?? '').toLowerCase() === 'number') return true;
    const placeholder = (el.placeholder ?? '').trim();
    return /^(?:\d{4}[\s-]){3}\d{4}$|^(?:[•*xX]{4}[\s-]){3}[•*xX\d]{4}$/.test(placeholder);
  }

  function isCvvField(el, hints) {
    if ((el.tagName ?? '').toUpperCase() !== 'INPUT') return false;
    const { tokens, text } = hints;
    if (tokens.has('cc-csc')) return true;
    if (isExcluded(hints)) return false;
    return /\b(?:cvv2?|cvc2?|csc|cid|cvn|cardcvc|encryptedsecuritycode|security[-_\s]*(?:code|num|number)|verification[-_\s]*(?:code|value|num)|card[-_\s]*code)\b/.test(text);
  }

  function isCombinedExpiryField(el, hints) {
    if ((el.tagName ?? '').toUpperCase() !== 'INPUT') return false;
    const { tokens, text } = hints;
    if (tokens.has('cc-exp')) return true;
    if (tokens.has('cc-exp-month') || tokens.has('cc-exp-year') || isExcluded(hints)) return false;
    if (/\b(?:month|year)\b/.test(text) && !/mm\s*[/\-]\s*yy/.test(text)) return false;
    return /\b(?:cc[-_\s]*exp(?:iry|iration)?|card[-_\s]*exp(?:iry|iration)?|encryptedexpirydate|exp[-_\s]*date|expiration[-_\s]*date|expiry[-_\s]*date|expiration|expiry|valid[-_\s]*thru|mm\s*[/\-]\s*yy(?:yy)?)\b/.test(text);
  }

  function isExpiryMonthField(_el, hints) {
    const { tokens, text } = hints;
    if (tokens.has('cc-exp-month')) return true;
    if (isExcluded(hints)) return false;
    return /\b(?:cc[-_\s]*exp[-_\s]*month|exp(?:iry|iration)?[-_\s]*month|card[-_\s]*month|encryptedexpirymonth|exp[-_\s]*mm|\bmm\b)\b/.test(text);
  }

  function isExpiryYearField(_el, hints) {
    const { tokens, text } = hints;
    if (tokens.has('cc-exp-year')) return true;
    if (isExcluded(hints)) return false;
    return /\b(?:cc[-_\s]*exp[-_\s]*year|exp(?:iry|iration)?[-_\s]*year|card[-_\s]*year|encryptedexpiryyear|exp[-_\s]*yy(?:yy)?|\byy(?:yy)?\b)\b/.test(text);
  }

  function fillExpiryMonth(el, mm, m) {
    const tag = (el.tagName ?? '').toUpperCase();
    if (tag === 'SELECT') {
      const monthNames = MONTHS[Number(mm) - 1] ?? [];
      return selectOption(el, [
        (val, txt) => val === mm || val === m || txt === mm || txt === m,
        (val, txt) => val.startsWith(`${mm} `) || val.startsWith(`${mm}-`) || txt.startsWith(`${mm} `) || txt.startsWith(`${mm}-`),
        (val, txt) => monthNames.some(name => val === name || txt.includes(name)),
      ]);
    }
    setFieldValue(el, el.maxLength === 1 ? m : mm);
    return true;
  }

  function fillExpiryYear(el, yy, yyyy) {
    const tag = (el.tagName ?? '').toUpperCase();
    if (tag === 'SELECT') {
      return selectOption(el, [
        (val, txt) => val === yyyy || val === yy || txt === yyyy || txt === yy,
        (val, txt) => val.endsWith(yyyy) || txt.endsWith(yyyy),
      ]);
    }
    const wantsFour = el.maxLength === 4 || /yyyy/i.test(el.placeholder ?? '');
    setFieldValue(el, wantsFour ? yyyy : yy);
    return true;
  }

  function fillCombinedExpiry(el, mm, yy, yyyy) {
    const type = (el.type ?? '').toLowerCase();
    if (type === 'month') {
      setFieldValue(el, `${yyyy}-${mm}`);
      return;
    }
    if (el.maxLength === 4) {
      setFieldValue(el, `${mm}${yy}`);
      return;
    }
    const placeholder = el.placeholder ?? '';
    const slash = /\s+\/\s+/.test(placeholder) ? ' / ' : '/';
    const targetYear = /yyyy/i.test(placeholder) || el.maxLength === 7 || el.maxLength === 9 ? yyyy : yy;
    setFieldValue(el, `${mm}${slash}${targetYear}`);

    // If an input mask inserts its own slash and corrupted the value,
    // retry with raw digits so the mask can format them cleanly.
    const currentDigits = String(el.value ?? '').replace(/\D/g, '');
    if (currentDigits !== `${mm}${targetYear}` && currentDigits !== `${mm}${yy}`) {
      setFieldValue(el, `${mm}${targetYear}`);
    }
  }

  function autofillCard(details) {
    if (!details || typeof document.querySelectorAll !== 'function') return { filled: [] };
    const candidates = queryAllDeep('input, select').filter(isCandidateInput);
    const described = candidates.map(el => ({ el, hints: hintsFor(el) }));
    const used = new Set();
    const filled = [];

    if (details.number) {
      const match = described.find(({ el, hints }) => !used.has(el) && isNumberField(el, hints));
      if (match) {
        used.add(match.el);
        fillPanField(match.el, details.number);
        filled.push('number');
      }
    }

    const expMatch = (details.expiry ?? '').match(/^(\d{2})\/(\d{2}|\d{4})$/);
    if (expMatch) {
      const mm = expMatch[1];
      const m = String(Number(mm));
      const yy = expMatch[2].slice(-2);
      const yyyy = expMatch[2].length === 4 ? expMatch[2] : `20${yy}`;

      const combined = described.find(({ el, hints }) => !used.has(el) && isCombinedExpiryField(el, hints));
      if (combined) {
        used.add(combined.el);
        fillCombinedExpiry(combined.el, mm, yy, yyyy);
        filled.push('expiry');
      } else {
        const monthField = described.find(({ el, hints }) => !used.has(el) && isExpiryMonthField(el, hints));
        const yearField = described.find(({ el, hints }) => !used.has(el) && el !== monthField?.el && isExpiryYearField(el, hints));
        let expiryFilled = false;
        if (monthField && fillExpiryMonth(monthField.el, mm, m)) {
          used.add(monthField.el);
          expiryFilled = true;
        }
        if (yearField && fillExpiryYear(yearField.el, yy, yyyy)) {
          used.add(yearField.el);
          expiryFilled = true;
        }
        if (expiryFilled) filled.push('expiry');
      }
    }

    if (details.cvv) {
      const match = described.find(({ el, hints }) => !used.has(el) && isCvvField(el, hints));
      if (match) {
        used.add(match.el);
        setFieldValue(match.el, details.cvv);
        filled.push('cvv');
      }
    }

    return { filled };
  }

  globalThis.vchAutofillCard = autofillCard;

  if (!globalThis.vchAutofillListenerAdded && globalThis.chrome?.runtime?.onMessage) {
    globalThis.vchAutofillListenerAdded = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'AUTOFILL_CARD') return undefined;
      sendResponse({ ok: true, filled: autofillCard(message.payload).filled });
      return false;
    });
  }
})();
