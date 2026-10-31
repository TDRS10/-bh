/* Account UI; loaded after app.js, before DOMContentLoaded. */
Object.assign(BHApp.prototype, {
  walletMoney(cents) { return (cents / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ج.م'; },
  walletBrand(brand) {
    const marks = {
      visa: '<span class="wallet-visa" aria-label="Visa">VISA</span>',
      mastercard: '<span class="wallet-mastercard" aria-label="Mastercard"><i></i><i></i><small>mastercard</small></span>',
      meeza: '<span class="wallet-meeza">ميزة</span>', cash: '<span>💵 كاش</span>', wallet: '<span>📱 محفظة</span>'
    };
    return marks[brand] || '';
  },
  renderWallet() {
    const grid = document.getElementById('walletCards');
    if (!grid) return;
    const accounts = this.data.walletAccounts || [], cards = this.data.walletCards || [], entries = this.data.walletEntries || [];
    document.getElementById('walletTotal').textContent = this.walletMoney(BHWallet.total(this.data));
    document.getElementById('walletCount').textContent = `${accounts.length} حساب · ${cards.length} كارت / محفظة`;
    grid.innerHTML = cards.length ? cards.map(card => {
      const balance = BHWallet.balance(this.data, card.accountId);
      const shared = cards.filter(c => c.accountId === card.accountId).length > 1;
      return `<article class="wallet-card wallet-${card.brand}">
        <div class="wallet-card-top"><span class="wallet-bank">${card.logo && BHWallet.logoOK(card.logo) ? `<img src="${card.logo}" alt="لوجو ${esc(card.bank || card.name)}">` : '<span aria-hidden="true">🏦</span>'}${esc(card.bank || 'حساب شخصي')}</span>${this.walletBrand(card.brand)}</div>
        <h3>${esc(card.name)}</h3><div class="wallet-digits" dir="ltr">${card.last4 ? '••••  ' + esc(card.last4) : '— — — —'}</div>
        <div class="wallet-card-foot"><div><small>رصيد الحساب${shared ? ' المشترك' : ''}</small><strong class="${balance < 0 ? 'negative' : ''}">${this.walletMoney(balance)}</strong></div><button type="button" class="btn btn-secondary btn-sm" onclick="app.walletSelect(${jsArg(card.accountId)})">العمليات</button></div>
        ${shared ? '<p class="wallet-shared">مرتبط بكارت آخر · محسوب مرة واحدة في الإجمالي</p>' : ''}
      </article>`;
    }).join('') : '<div class="empty-state">💳<h3>كل كروتك في مكان واحد</h3><p>ضيف أول كارت وسجّل الرصيد اللي فيه دلوقتي.</p></div>';
    const options = accounts.map(a => `<option value="${esc(a.id)}">${esc(a.name)} — ${this.walletMoney(BHWallet.balance(this.data, a.id))}</option>`).join('');
    for (const key of ['walletFrom', 'walletTo', 'walletLink', 'walletFilter']) {
      const el = document.getElementById(key), selected = el.value;
      el.innerHTML = (key === 'walletLink' ? '<option value="">حساب جديد برصيد مستقل</option>' : key === 'walletFilter' ? '<option value="">كل الحسابات</option>' : '<option value="">اختار الحساب</option>') + options;
      if (accounts.some(a => a.id === selected)) el.value = selected;
    }
    document.getElementById('walletMovementFieldset').disabled = !accounts.length;
    document.getElementById('walletNegative').hidden = !accounts.some(a => BHWallet.balance(this.data, a.id) < 0);
    this.walletLinkChanged();
    this.walletKindChanged();
    this.renderWalletHistory();
  },
  renderWalletHistory() {
    const filter = document.getElementById('walletFilter').value;
    const entries = (this.data.walletEntries || []).filter(e => !filter || e.from === filter || e.to === filter).slice().sort((a,b) => b.date.localeCompare(a.date));
    const name = id => esc((this.data.walletAccounts || []).find(a => a.id === id)?.name || 'حساب غير متاح');
    const labels = { opening: 'رصيد البداية', deposit: 'إيداع', withdrawal: 'سحب / مصروف', transfer: 'تحويل' };
    document.getElementById('walletHistory').innerHTML = entries.slice(0,100).map(e => `<div class="wallet-history-item"><div><strong>${labels[e.kind]}</strong><p>${e.from ? name(e.from) : 'من خارج الحسابات'} ← ${e.to ? name(e.to) : 'خارج الحسابات'}</p><small>${esc(e.note)} · ${new Date(e.date).toLocaleString('ar-EG')}</small></div><b>${this.walletMoney(e.cents)}</b></div>`).join('') || '<p class="empty-state">لسه مفيش عمليات للحساب ده.</p>';
    document.getElementById('walletHistoryCount').textContent = entries.length > 100 ? `أحدث 100 من ${entries.length} عملية` : `${entries.length} عملية`;
  },
  walletSelect(id) {
    document.getElementById('walletFilter').value = id;
    document.getElementById('walletFrom').value = id;
    document.getElementById('walletTo').value = id;
    this.renderWalletHistory();
    document.getElementById('walletMovement').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  walletLinkChanged() {
    const linked = !!document.getElementById('walletLink').value;
    document.getElementById('walletOpeningGroup').hidden = linked;
    document.getElementById('walletOpening').disabled = linked;
  },
  walletKindChanged() {
    const kind = document.getElementById('walletKind').value;
    document.getElementById('walletFromGroup').hidden = kind === 'deposit';
    document.getElementById('walletToGroup').hidden = kind === 'withdrawal';
    document.getElementById('walletFrom').required = kind !== 'deposit';
    document.getElementById('walletTo').required = kind !== 'withdrawal';
  },
  walletLogo(file) {
    if (!file) return Promise.resolve('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) return Promise.reject(Error('اختار صورة PNG أو JPG أو WebP أصغر من 2 ميجا'));
    return new Promise((resolve, reject) => {
      const image = new Image(), url = URL.createObjectURL(file);
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas'), scale = Math.min(1, 160 / Math.max(image.width, image.height));
          canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          const logo = canvas.toDataURL('image/png');
          if (!BHWallet.logoOK(logo)) throw Error('اللوجو كبير؛ اختار صورة أبسط');
          resolve(logo);
        } catch (error) { reject(error); } finally { URL.revokeObjectURL(url); }
      };
      image.onerror = () => { URL.revokeObjectURL(url); reject(Error('الصورة غير صالحة')); };
      image.src = url;
    });
  },
  persistWallet(next) {
    // Commit locally before updating UI; never show success when storage fails.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    this.data = next;
    try { localStorage.setItem(LOCAL_TIME_KEY, String(Date.now())); } catch (error) { console.warn(error); }
    this._saveSnapshot();
    this._scheduleCloudPush();
    this.renderWallet();
  },
  async walletAdd(event) {
    event.preventDefault();
    const button = document.getElementById('walletAddButton');
    if (button.disabled) return;
    button.disabled = true;
    const value = id => document.getElementById(id).value;
    const input = { name: value('walletName'), bank: value('walletBank'), brand: value('walletBrand'), last4: value('walletLast4'), accountId: value('walletLink'), opening: value('walletOpening') };
    try {
      input.logo = await this.walletLogo(document.getElementById('walletLogoFile').files[0]);
      this.persistWallet(BHWallet.create(this.data, input));
      event.target.reset(); this.walletLinkChanged();
      document.getElementById('walletAddDetails').open = false;
      document.getElementById('walletStatus').textContent = 'تمت إضافة الكارت وحفظه على الجهاز ✓';
    } catch (error) { document.getElementById('walletStatus').textContent = error.name === 'QuotaExceededError' ? 'المساحة ممتلئة؛ لم يتم حفظ الكارت' : error.message; }
    finally { button.disabled = false; }
  },
  walletMove(event) {
    event.preventDefault();
    const value = id => document.getElementById(id).value;
    try {
      this.persistWallet(BHWallet.move(this.data, { kind: value('walletKind'), from: value('walletFrom'), to: value('walletTo'), amount: value('walletAmount'), note: value('walletNote') }));
      document.getElementById('walletAmount').value = '';
      document.getElementById('walletNote').value = '';
      document.getElementById('walletMoveStatus').textContent = 'تم تسجيل العملية وحفظها ✓';
    } catch (error) { document.getElementById('walletMoveStatus').textContent = error.name === 'QuotaExceededError' ? 'المساحة ممتلئة؛ لم يتم حفظ العملية' : error.message; }
  }
});
