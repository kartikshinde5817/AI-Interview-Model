'use strict';

const $ = (s, r = document) => r.querySelector(s);

const form = $('#applyForm');
const err = $('#applyErr');

for (const name of ['mobile', 'aadhaar']) {
  form.elements[name].addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, e.target.maxLength);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.add('hide');
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try {
    const res = await fetch(location.pathname.replace('/apply/', '/api/apply/'), {
      method: 'POST',
      body: new FormData(form),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not submit the application.');
    form.classList.add('hide');
    $('#applyDone').classList.remove('hide');
  } catch (e2) {
    err.textContent = e2.message;
    err.classList.remove('hide');
    btn.disabled = false;
    btn.textContent = 'Submit application';
  }
});
