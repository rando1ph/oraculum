if (new URLSearchParams(location.search).get('state') === 'error') {
  document.body.classList.add('failed');
  document.querySelector('.recovery').hidden = false;
}
