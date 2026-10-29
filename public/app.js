/* Clinic booking demo. Talks to the assessment API on the same origin. */
const API_KEY = window.APP_CONFIG?.apiKey ?? '';
const API = location.origin;

const state = {
  slots: [],
  provider: null,
  selectedId: null,
  idemKey: null,
  bookings: [],
  cursor: null,
  lookupEmail: '',
};

const $ = (id) => document.getElementById(id);

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, retryAfter: res.headers.get('retry-after') };
}

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const prettyRange = (slot) => `${timeFmt.format(new Date(slot.start))} – ${timeFmt.format(new Date(slot.end))}`;

function slotLabel(slotId) {
  const slot = state.slots.find((s) => s.id === slotId);
  if (!slot) return slotId;
  return `${shortDayFmt.format(new Date(slot.start))} · ${prettyRange(slot)}`;
}

/* ------------------------------------------------------------------- slots */

function renderProviders() {
  const container = $('providers');
  container.replaceChildren();
  const providers = [...new Set(state.slots.map((slot) => slot.provider))].sort();
  if (providers.length < 2) return;

  const chips = [['All providers', null], ...providers.map((name) => [name, name])];
  for (const [label, value] of chips) {
    container.append(
      h('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(state.provider === value),
        onclick: () => {
          state.provider = value;
          renderProviders();
          renderSlots();
        },
      }, label),
    );
  }
}

function renderSlots() {
  const list = $('slot-list');
  list.replaceChildren();

  const visible = state.provider ? state.slots.filter((slot) => slot.provider === state.provider) : state.slots;

  if (visible.length === 0) {
    list.append(h('p', { class: 'slots__empty', text: 'No slots are open right now. The clinic has not published any times yet.' }));
    return;
  }

  let lastDay = null;
  for (const slot of visible) {
    const start = new Date(slot.start);
    const key = dayKey(start);
    if (key !== lastDay) {
      lastDay = key;
      list.append(
        h('div', { class: 'day' },
          h('span', { class: 'day__name', text: dayFmt.format(start) }),
        ),
      );
    }

    const selected = state.selectedId === slot.id;
    list.append(
      h('button', {
        class: `slot${selected ? ' is-selected' : ''}`,
        type: 'button',
        disabled: !slot.available,
        'aria-pressed': String(selected),
        onclick: () => selectSlot(slot.id),
      },
        h('span', { class: 'slot__time', text: prettyRange(slot) }),
        h('span', { class: 'slot__provider', text: slot.provider }),
        h('span', { class: `slot__tag${slot.available ? '' : ' slot__tag--taken'}`, text: slot.available ? (selected ? 'Selected' : 'Choose') : 'Booked' }),
      ),
    );
  }
}

async function loadSlots({ keepSelection = true } = {}) {
  try {
    const res = await api('/slots');
    if (res.status !== 200) throw new Error('Could not load slots');
    state.slots = res.data.slots ?? [];
    const stillOpen = state.slots.some((slot) => slot.id === state.selectedId && slot.available);
    if (!keepSelection || !stillOpen) {
      const wasChoosing = state.selectedId !== null;
      state.selectedId = null;
      state.idemKey = null;
      // Someone took the slot while this visitor was filling the form.
      if (wasChoosing && !$('panel-form').hidden) {
        showStateMessage('That slot just went', 'Someone else booked it while you were filling in your details. The list is refreshed — pick another open time.');
      }
    }
    renderProviders();
    renderSlots();
  } catch (err) {
    $('slot-list').replaceChildren(h('p', { class: 'slots__error', text: 'Slots could not be loaded. Refresh to try again.' }));
  }
}

/* ------------------------------------------------------------------- panel */

function showPanel(name) {
  $('panel-empty').hidden = name !== 'empty';
  $('panel-form').hidden = name !== 'form';
  $('panel-done').hidden = name !== 'done';
  $('panel-state').hidden = name !== 'state';
}

function setFieldError(message, kind = 'error') {
  const box = $('form-error');
  if (!message) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = message;
  box.dataset.kind = kind;
}

function selectSlot(slotId) {
  const slot = state.slots.find((entry) => entry.id === slotId);
  if (!slot || !slot.available) return;

  state.selectedId = slotId;
  state.idemKey = crypto.randomUUID();
  setFieldError('');
  $('name').removeAttribute('aria-invalid');
  $('email').removeAttribute('aria-invalid');

  $('slot-summary').replaceChildren(
    h('strong', { text: `${dayFmt.format(new Date(slot.start))}, ${prettyRange(slot)}` }),
    h('span', { text: `${slot.provider} · slot ${slot.id}` }),
  );

  $('book-btn').disabled = false;
  $('book-btn').textContent = 'Confirm booking';
  renderSlots();
  showPanel('form');
  $('name').focus();
}

function showStateMessage(title, body) {
  $('state-title').textContent = title;
  $('state-body').textContent = body;
  showPanel('state');
}

async function submitBooking(event) {
  event.preventDefault();
  const name = $('name').value.trim();
  const email = $('email').value.trim().toLowerCase();
  const button = $('book-btn');

  $('name').removeAttribute('aria-invalid');
  $('email').removeAttribute('aria-invalid');
  setFieldError('');

  if (!name) {
    $('name').setAttribute('aria-invalid', 'true');
    setFieldError('Please add your full name.');
    $('name').focus();
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    $('email').setAttribute('aria-invalid', 'true');
    setFieldError('That email address does not look right.');
    $('email').focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Booking…';

  let res;
  try {
    res = await api('/bookings', {
      method: 'POST',
      body: { slot_id: state.selectedId, name, email },
      headers: state.idemKey ? { 'Idempotency-Key': state.idemKey } : {},
    });
  } catch {
    button.disabled = false;
    button.textContent = 'Try again';
    setFieldError('The clinic API could not be reached. Your slot is still held — press try again.', 'wait');
    return;
  }

  if (res.status === 201) {
    state.idemKey = null;
    const booking = res.data;
    $('done-lead').textContent = `We have reserved ${slotLabel(booking.slot_id)} for ${booking.name}.`;
    $('done-receipt').replaceChildren(
      h('div', {}, h('dt', { text: 'Booking id' }), h('dd', {}, h('code', { text: booking.id }))),
      h('div', {}, h('dt', { text: 'When' }), h('dd', { text: slotLabel(booking.slot_id) })),
      h('div', {}, h('dt', { text: 'Provider' }), h('dd', { text: state.slots.find((s) => s.id === booking.slot_id)?.provider ?? '—' })),
      h('div', {}, h('dt', { text: 'Email' }), h('dd', { text: booking.email })),
      h('div', {}, h('dt', { text: 'Status' }), h('dd', { text: booking.status })),
    );
    $('lookup-email').value = booking.email;
    showPanel('done');
    await loadSlots({ keepSelection: false });
    return;
  }

  button.disabled = false;
  button.textContent = 'Confirm booking';

  if (res.status === 409 || res.status === 404) {
    state.idemKey = null;
    await loadSlots({ keepSelection: false });
    showStateMessage(
      'That slot just went',
      'Someone else booked it a moment before you. The list is refreshed — pick another open time.',
    );
    return;
  }
  if (res.status === 429) {
    const wait = Number(res.retryAfter || 60);
    setFieldError(`Too many booking attempts for this email. Try again in ${wait} second${wait === 1 ? '' : 's'}.`, 'wait');
    return;
  }
  if (res.status === 422) {
    state.idemKey = crypto.randomUUID();
    setFieldError('This attempt was already used with different details. Press confirm to send it fresh.', 'wait');
    return;
  }
  if (res.status === 400) {
    setFieldError(res.data?.error ?? 'Those details were rejected.');
    return;
  }
  if (res.status === 401) {
    setFieldError('This page could not authenticate with the API key.');
    return;
  }
  setFieldError(res.data?.error ?? 'The booking could not be completed. Please try again.');
}

/* ---------------------------------------------------------------- bookings */

function renderBookingList() {
  const list = $('booking-list');
  list.replaceChildren();

  if (state.bookings.length === 0) {
    list.append(h('p', { class: 'booking-empty', text: state.lookupEmail ? 'No bookings for that email yet.' : 'Enter the email you booked with to see your appointments.' }));
    $('load-more').hidden = true;
    return;
  }

  for (const booking of state.bookings) {
    const slot = state.slots.find((s) => s.id === booking.slot_id);
    const main = h('div', { class: 'booking__main' },
      h('strong', { text: slot ? slotLabel(booking.slot_id) : booking.slot_id }),
      h('span', { text: `${slot?.provider ?? 'Clinic'} · ${booking.email}` }),
    );

    const children = [main, h('span', { class: `status status--${booking.status}`, text: booking.status })];

    if (booking.status === 'confirmed') {
      children.push(
        h('button', {
          class: 'booking__cancel',
          type: 'button',
          onclick: (event) => cancelBooking(booking, event.currentTarget),
        }, 'Cancel'),
      );
    } else {
      children.push(h('span'));
    }

    list.append(h('div', { class: 'booking', 'data-id': booking.id }, ...children));
  }

  $('load-more').hidden = !state.cursor;
}

function setLookupNote(text) {
  $('lookup-note').textContent = text;
}

async function fetchBookings({ append = false } = {}) {
  const email = $('lookup-email').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    setLookupNote('Enter a valid email address.');
    return;
  }

  state.lookupEmail = email;
  const params = new URLSearchParams({ email, limit: '5' });
  if (append && state.cursor) params.set('cursor', state.cursor);

  try {
    const res = await api(`/bookings?${params.toString()}`);
    if (res.status !== 200) {
      setLookupNote(res.data?.error ?? 'Those bookings could not be loaded.');
      return;
    }
    const page = res.data.bookings ?? [];
    state.bookings = append ? [...state.bookings, ...page] : page;
    state.cursor = res.data.next_cursor ?? null;

    renderBookingList();
    $('lookup-email').value = email;
    setLookupNote(
      page.length === 0 && !append
        ? ''
        : `${state.bookings.length} booking${state.bookings.length === 1 ? '' : 's'}${state.cursor ? ' so far' : ''}`,
    );
  } catch {
    setLookupNote('The clinic API could not be reached.');
  }
}

async function cancelBooking(booking, button) {
  button.disabled = true;
  button.textContent = 'Cancelling…';
  let res;
  try {
    res = await api(`/bookings/${encodeURIComponent(booking.id)}`, { method: 'DELETE' });
  } catch {
    button.disabled = false;
    button.textContent = 'Cancel';
    setLookupNote('The clinic API could not be reached.');
    return;
  }

  if (res.status === 200) {
    booking.status = 'cancelled';
    renderBookingList();
    setLookupNote('Booking cancelled — the slot is open again.');
    await loadSlots({ keepSelection: false });
    return;
  }
  button.disabled = false;
  button.textContent = 'Cancel';
  setLookupNote(res.data?.error ?? 'The booking could not be cancelled.');
  if (res.status === 409) {
    booking.status = 'cancelled';
    renderBookingList();
  }
}

/* -------------------------------------------------------------------- wiring */

$('panel-form').addEventListener('submit', submitBooking);
$('form-cancel').addEventListener('click', () => {
  state.selectedId = null;
  state.idemKey = null;
  renderSlots();
  showPanel('empty');
});
$('done-bookings').addEventListener('click', () => {
  document.getElementById('your-bookings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  fetchBookings();
});
$('done-again').addEventListener('click', () => {
  state.selectedId = null;
  showPanel('empty');
});
$('state-back').addEventListener('click', () => showPanel('empty'));
$('lookup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.cursor = null;
  state.bookings = [];
  fetchBookings();
});
$('load-more').addEventListener('click', () => fetchBookings({ append: true }));

zoneName && document.querySelector('.foot p').setAttribute('title', `Times shown in ${zoneName}`);
renderBookingList();
loadSlots();

// Slots change underneath us when other people book; keep the list honest.
setInterval(() => {
  if (state.selectedId === null && document.visibilityState === 'visible') loadSlots();
}, 20000);
