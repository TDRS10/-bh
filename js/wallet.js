/* Immutable account movements, in integer piastres. No bank credentials. */
const BHWallet = (() => {
  const collections = ['walletAccounts', 'walletCards', 'walletEntries'];
  const brands = ['visa', 'mastercard', 'meeza', 'cash', 'wallet'];
  const id = () => crypto.randomUUID();
  const money = value => {
    const raw = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw Error('اكتب مبلغ صحيح بحد أقصى رقمين بعد العلامة');
    const cents = Math.round(Number(raw) * 100);
    if (!Number.isSafeInteger(cents) || cents > 100000000000) throw Error('المبلغ أكبر من الحد المسموح');
    return cents;
  };
  const list = (data, key) => data[key] || [];
  const balance = (data, accountId) => list(data, 'walletEntries').reduce((sum, entry) =>
    sum + (entry.to === accountId ? entry.cents : 0) - (entry.from === accountId ? entry.cents : 0), 0);
  const total = data => list(data, 'walletAccounts').reduce((sum, a) => sum + balance(data, a.id), 0);
  const logoOK = value => typeof value === 'string' && (value === '' || (value.length <= 180000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)));
  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('بيانات الحسابات غير صالحة');
    for (const key of collections) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw Error('بيانات الحسابات غير صالحة');
      const seen = new Set();
      for (const row of list(data, key)) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw Error('معرف حساب أو عملية غير صالح');
        seen.add(row.id);
        if (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) throw Error('تاريخ الحساب أو العملية غير صالح');
        if (key === 'walletAccounts' && (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60)) throw Error('اسم الحساب غير صالح');
        if (key === 'walletCards' && (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60 || typeof row.bank !== 'string' || row.bank.length > 60 || !brands.includes(row.brand) || !/^(\d{4})?$/.test(row.last4) || !logoOK(row.logo) || typeof row.accountId !== 'string')) throw Error('بيانات الكارت غير صالحة');
        if (key === 'walletEntries' && (!Number.isSafeInteger(row.cents) || row.cents <= 0 || row.cents > 100000000000 || typeof row.from !== 'string' || typeof row.to !== 'string' || (!row.from && !row.to) || row.from === row.to || !['opening', 'deposit', 'withdrawal', 'transfer'].includes(row.kind) || typeof row.note !== 'string' || row.note.length > 160 || !Number.isFinite(Date.parse(row.date)))) throw Error('حركة حساب غير صالحة');
      }
    }
  }
  function create(data, input) {
    const name = input.name.trim(), bank = input.bank.trim(), last4 = input.last4.trim();
    if (!name || name.length > 60 || bank.length > 60 || !brands.includes(input.brand) || !/^(\d{4})?$/.test(last4) || !logoOK(input.logo || '')) throw Error('راجع اسم الكارت وآخر 4 أرقام واللوجو');
    let accountId = input.accountId;
    const next = { ...data };
    for (const key of collections) next[key] = [...list(data, key)];
    if (accountId) {
      if (!next.walletAccounts.some(a => a.id === accountId)) throw Error('الحساب المرتبط غير موجود');
    } else {
      const cents = money(input.opening);
      accountId = id();
      next.walletAccounts.push({ id: accountId, name, date: new Date().toISOString() });
      if (cents) next.walletEntries.push({ id: id(), from: '', to: accountId, cents, kind: 'opening', note: 'رصيد البداية', date: new Date().toISOString() });
    }
    next.walletCards.push({ id: id(), accountId, name, bank, brand: input.brand, last4, logo: input.logo || '', date: new Date().toISOString() });
    validate(next);
    return next;
  }
  function move(data, input) {
    if (!['deposit', 'withdrawal', 'transfer'].includes(input.kind)) throw Error('اختار نوع العملية');
    const cents = money(input.amount);
    if (!cents) throw Error('المبلغ لازم يكون أكبر من صفر');
    const from = input.kind === 'deposit' ? '' : input.from;
    const to = input.kind === 'withdrawal' ? '' : input.to;
    if (from === to) throw Error('اختار حسابين مختلفين للتحويل');
    for (const account of [from, to].filter(Boolean)) {
      if (!list(data, 'walletAccounts').some(a => a.id === account)) throw Error('الحساب غير موجود');
    }
    if ((input.kind !== 'deposit' && !from) || (input.kind !== 'withdrawal' && !to)) throw Error('اختار الحساب');
    if (from && balance(data, from) < cents) throw Error('الرصيد غير كافي للعملية');
    const entry = { id: id(), from, to, cents, kind: input.kind, note: String(input.note || '').trim(), date: new Date().toISOString() };
    const next = { ...data, walletEntries: [...list(data, 'walletEntries'), entry] };
    validate(next);
    return next;
  }
  return { collections, brands, money, balance, total, validate, create, move, logoOK };
})();
