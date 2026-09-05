document.querySelector('#sale')?.addEventListener('click', () => {
  // Retain the site's original Text node, as a reactive renderer might.
  document.querySelector('#simple').firstChild.textContent = '$18.00';
});
document.querySelector('#add')?.addEventListener('click', () => {
  const product = document.createElement('article');
  product.innerHTML = '<div class="product-image">⌁</div><p class="category">JUST ADDED</p><h2>Wool throw</h2><p class="price added-price">USD 65.00</p>';
  document.querySelector('#products').append(product);
});
document.querySelector('#cart')?.addEventListener('click', () => {
  const count = document.querySelector('#click-count'); count.textContent = String(Number(count.textContent) + 1);
});
