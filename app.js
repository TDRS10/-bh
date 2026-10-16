/**
 * BH Personal Finance Application - Core Logic
 * Tailored for Delivery Riders with Variable Income
 */

const STORAGE_KEY = 'BH_APP_DATA_V1';

class BHApp {
  constructor() {
    this.data = this.loadData();
    this.currentTab = 'dashboardView';
    this.pendingExpensiveExpense = null;
    this.initDateInputs();
    this.init();
  }

  // Initial State Factory
  getDefaultData() {
    const today = new Date().toISOString().split('T')[0];
    return {
      settings: {
        savingsRatio: 50,
        essentialsRatio: 30,
        outingsRatio: 20,
        weeklyOutingsBudget: 300,
        lastSavingsWithdrawalDate: today,
        savingsStreakDays: 0,
        bigNumbersMode: false
      },
      balances: {
        reservedSavings: 0,
        spendableBalance: 0
      },
      incomes: [],
      expenses: [],
      goals: [
        {
          id: 'goal_' + Date.now(),
          title: 'سداد ديون / تحويش صيانة سكوتر',
          targetAmount: 5000,
          currentAmount: 0,
          date: today
        }
      ],
      debts: [],
      riderShifts: [],
      pendingIncomes: []
    };
  }

  // Load from LocalStorage with fallback
  loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.getDefaultData();
      const parsed = JSON.parse(raw);
      // Merge with defaults in case of missing keys
      return { ...this.getDefaultData(), ...parsed, pendingIncomes: parsed.pendingIncomes || [] };
    } catch (e) {
      console.error('Error loading LocalStorage data', e);
      return this.getDefaultData();
    }
  }

  // Save State to LocalStorage
  saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error('Error saving data to LocalStorage', e);
      this.showToast('⚠️ تعذر حفظ البيانات في الذاكرة المحلية');
    }
  }

  // App Initialization
  init() {
    this.applyBigNumbersMode();
    this.updateStreakCount();
    this.renderAll();
    this.calculateShiftNet();
  }

  applyBigNumbersMode() {
    const isBig = !!this.data.settings.bigNumbersMode;
    document.body.classList.toggle('big-numbers-mode', isBig);
    const btn = document.getElementById('bigNumbersToggleBtn');
    if (btn) btn.textContent = isBig ? 'إلغاء التفعيل ✖️' : 'تفعيل 👁️';
  }

  toggleBigNumbers() {
    this.data.settings.bigNumbersMode = !this.data.settings.bigNumbersMode;
    this.applyBigNumbersMode();
    this.saveData();
    const isBig = this.data.settings.bigNumbersMode;
    this.showToast(isBig ? '👁️ تم تفعيل وضع الأرقام المكبرة' : '👁️ تم العودة لوضع الأرقام العادية');
  }

  // Set default dates to today
  initDateInputs() {
    const today = new Date().toISOString().split('T')[0];
    ['incomeDate', 'expenseDate'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = today;
    });
  }

  // Tab Navigation
  switchTab(viewId, navEl = null) {
    document.querySelectorAll('.view-page').forEach(page => {
      page.classList.remove('active');
    });
    const target = document.getElementById(viewId);
    if (target) target.classList.add('active');

    // Update bottom nav active state
    if (navEl) {
      document.querySelectorAll('.bottom-nav .nav-item').forEach(item => item.classList.remove('active'));
      navEl.classList.add('active');
    } else {
      document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
        const onclickAttr = item.getAttribute('onclick') || '';
        if (onclickAttr.includes(viewId)) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }

    this.currentTab = viewId;
    if (viewId === 'moreView') {
      this.renderReportChart();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Modal Controllers
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
    }
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Toast System
  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  // Streak Tracker Logic
  updateStreakCount() {
    const lastWithdraw = this.data.settings.lastSavingsWithdrawalDate;
    if (!lastWithdraw) {
      this.data.settings.savingsStreakDays = 0;
      return;
    }

    const start = new Date(lastWithdraw);
    const now = new Date();
    const diffTime = Math.abs(now - start);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    this.data.settings.savingsStreakDays = diffDays;
    
    let text = `🔥 ${diffDays} يوم بدون لمس التحويش!`;
    if (diffDays >= 30) {
      text = `🏆 ${diffDays} يوم (شهر كامل بدون كسر التحويش!)`;
    } else if (diffDays >= 14) {
      text = `🔥🔥 ${diffDays} يوم! (أنت بدأت تمسك فلوسك بجد!)`;
    }

    const badgeHeader = document.getElementById('headerStreakBadge');
    const badgeMotivation = document.getElementById('motivationStreakText');
    if (badgeHeader) badgeHeader.textContent = text;
    if (badgeMotivation) badgeMotivation.textContent = text;
  }

  // Handle New Income Addition (+ قبض جديد أو قيد الانتظار)
  handleNewIncome(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('incomeAmount').value);
    const date = document.getElementById('incomeDate').value || new Date().toISOString().split('T')[0];
    const source = document.getElementById('incomeSource').value;
    const notes = document.getElementById('incomeNote').value || '';
    const status = (document.getElementById('incomeStatus') && document.getElementById('incomeStatus').value) || 'received';

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ قبض صحيح');
      return;
    }

    // ⏳ Handle Pending Income (لم يُستلم بعد)
    if (status === 'pending') {
      const pendingEntry = {
        id: 'pend_' + Date.now(),
        amount,
        source,
        notes,
        date
      };

      if (!this.data.pendingIncomes) this.data.pendingIncomes = [];
      this.data.pendingIncomes.unshift(pendingEntry);
      this.saveData();
      this.closeModal('newIncomeModal');
      this.renderAll();
      this.showToast('⏳ تم تسجيل القبض كـ "قيد الانتظار" بنجاح', 'info');
      document.getElementById('incomeAmount').value = '';
      document.getElementById('incomeNote').value = '';
      return;
    }

    // ✅ Handle Received Income (استلام فوري وتقسيم)
    const sRatio = this.data.settings.savingsRatio / 100;
    const eRatio = this.data.settings.essentialsRatio / 100;
    const oRatio = this.data.settings.outingsRatio / 100;

    const savingsAmt = Math.round(amount * sRatio);
    const essentialsAmt = Math.round(amount * eRatio);
    const outingsAmt = Math.round(amount * oRatio);

    // Update Balances
    this.data.balances.reservedSavings += savingsAmt;
    this.data.balances.spendableBalance += (essentialsAmt + outingsAmt);

    const incomeEntry = {
      id: 'inc_' + Date.now(),
      amount,
      savingsAmt,
      essentialsAmt,
      outingsAmt,
      date,
      source,
      notes
    };

    this.data.incomes.unshift(incomeEntry);
    this.saveData();
    this.closeModal('newIncomeModal');

    // Populate Celebration Screen
    document.getElementById('celebSavingsRatio').textContent = this.data.settings.savingsRatio;
    document.getElementById('celebEssentialsRatio').textContent = this.data.settings.essentialsRatio;
    document.getElementById('celebOutingsRatio').textContent = this.data.settings.outingsRatio;

    document.getElementById('celebSavingsAmt').textContent = savingsAmt + ' ج.م';
    document.getElementById('celebEssentialsAmt').textContent = essentialsAmt + ' ج.م';
    document.getElementById('celebOutingsAmt').textContent = outingsAmt + ' ج.م';

    this.openModal('incomeCelebrationModal');
    this.renderAll();
    
    // Reset Form
    document.getElementById('incomeAmount').value = '';
    document.getElementById('incomeNote').value = '';
  }

  // Confirm Receipt of Pending Income (تحويل من "قيد الانتظار" إلى "قبض حقيقي")
  confirmPendingIncome(pendId) {
    const item = (this.data.pendingIncomes || []).find(p => p.id === pendId);
    if (!item) return;

    const amount = item.amount;
    const sRatio = this.data.settings.savingsRatio / 100;
    const eRatio = this.data.settings.essentialsRatio / 100;
    const oRatio = this.data.settings.outingsRatio / 100;

    const savingsAmt = Math.round(amount * sRatio);
    const essentialsAmt = Math.round(amount * eRatio);
    const outingsAmt = Math.round(amount * oRatio);

    this.data.balances.reservedSavings += savingsAmt;
    this.data.balances.spendableBalance += (essentialsAmt + outingsAmt);

    this.data.incomes.unshift({
      id: 'inc_' + Date.now(),
      amount,
      savingsAmt,
      essentialsAmt,
      outingsAmt,
      date: new Date().toISOString().split('T')[0],
      source: item.source,
      notes: item.notes ? `استلام قبض منتظر: ${item.notes}` : 'استلام قبض كان قيد الانتظار'
    });

    this.data.pendingIncomes = this.data.pendingIncomes.filter(p => p.id !== pendId);
    this.saveData();

    // Populate Celebration Screen
    document.getElementById('celebSavingsRatio').textContent = this.data.settings.savingsRatio;
    document.getElementById('celebEssentialsRatio').textContent = this.data.settings.essentialsRatio;
    document.getElementById('celebOutingsRatio').textContent = this.data.settings.outingsRatio;

    document.getElementById('celebSavingsAmt').textContent = savingsAmt + ' ج.م';
    document.getElementById('celebEssentialsAmt').textContent = essentialsAmt + ' ج.م';
    document.getElementById('celebOutingsAmt').textContent = outingsAmt + ' ج.م';

    this.openModal('incomeCelebrationModal');
    this.renderAll();
    this.showToast(`🎉 تم استلام ${amount.toLocaleString()} ج.م وتقسيمها للتحويش والصرف بنجاح!`, 'success');
  }

  // Delete Pending Income
  deletePendingIncome(pendId) {
    if (!confirm('هل أنت متأكد من حذف هذا القبض المنتظر؟')) return;
    this.data.pendingIncomes = (this.data.pendingIncomes || []).filter(p => p.id !== pendId);
    this.saveData();
    this.renderAll();
    this.showToast('🗑️ تم حذف القبض المنتظر بنجاح');
  }

  // Handle New Expense (+ مصروف)
  handleNewExpense(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const category = document.getElementById('expenseCategory').value;
    const note = document.getElementById('expenseNote').value || '';
    const date = document.getElementById('expenseDate').value || new Date().toISOString().split('T')[0];

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ مصروف صحيح');
      return;
    }

    if (amount > this.data.balances.spendableBalance) {
      this.showToast('⚠️ عذراً! المبلغ المطلوب يجاوز المتاح للصرف حالياً');
    }

    // 🚨 Expensive Outing / Sama Check
    if (category === 'خروجة' || category === 'سما') {
      const budget = this.data.settings.weeklyOutingsBudget;
      const spent = this.getWeeklyOutingsSpent();
      const remaining = Math.max(0, budget - spent);

      // Ratio percent relative to remaining budget (or total budget if remaining <= 0)
      const baseForPercent = remaining > 0 ? remaining : Math.max(1, budget);
      const ratioPercent = Math.round((amount / baseForPercent) * 100);

      // Trigger warning modal for ratio >= 50%
      if (ratioPercent >= 50) {
        this.pendingExpensiveExpense = { amount, category, note, date };

        const spendableAfter = Math.max(0, this.data.balances.spendableBalance - amount);
        const budgetAfter = Math.max(0, remaining - amount);

        document.getElementById('expOutingAmt').textContent = `${amount.toLocaleString()} ج.م`;
        document.getElementById('expOutingSpendableAfter').textContent = `${spendableAfter.toLocaleString()} ج.م`;
        document.getElementById('expOutingBudgetAfter').textContent = `${budgetAfter.toLocaleString()} ج.م`;
        document.getElementById('expOutingRatioPercent').textContent = `${ratioPercent}%`;

        const banner = document.getElementById('expensiveOutingBanner');
        const title = document.getElementById('expensiveOutingWarnTitle');
        const desc = document.getElementById('expensiveOutingWarnDesc');

        if (ratioPercent >= 100) {
          if (banner) banner.className = 'decision-card decision-red';
          if (title) title.textContent = '🚨 خروجة غالية جداً!';
          if (desc) desc.textContent = `الخروجة دي هتستهلك ${ratioPercent}% من ميزانية خروجاتك المتبقية.`;
        } else {
          if (banner) banner.className = 'decision-card decision-yellow';
          if (title) title.textContent = '🟡 تنبيه: خروجة مكلفة نسبياً';
          if (desc) desc.textContent = `الخروجة دي هتستهلك ${ratioPercent}% من ميزانية خروجاتك المتبقية.`;
        }

        this.openModal('expensiveOutingModal');
        return; // Pause execution until user confirms or cancels in modal!
      }
    }

    // Standard expense execution
    this.saveExpenseData({ amount, category, note, date });
  }

  confirmExpensiveExpense() {
    if (!this.pendingExpensiveExpense) return;
    const item = this.pendingExpensiveExpense;
    this.pendingExpensiveExpense = null;
    this.closeModal('expensiveOutingModal');
    this.saveExpenseData(item);
  }

  cancelExpensiveExpense() {
    this.pendingExpensiveExpense = null;
    this.closeModal('expensiveOutingModal');
    this.showToast('ℹ️ تم إلغاء تسجيل الخروجة');
  }

  saveExpenseData({ amount, category, note, date }) {
    // Deduct from spendable balance
    this.data.balances.spendableBalance -= amount;

    const expenseEntry = {
      id: 'exp_' + Date.now(),
      amount,
      category,
      note,
      date
    };

    this.data.expenses.unshift(expenseEntry);
    this.saveData();
    this.closeModal('newExpenseModal');
    this.renderAll();

    this.showToast(`✅ تم خصم ${amount} ج.م بنجاح من المتاح للصرف`);
    
    const amtEl = document.getElementById('expenseAmount');
    const noteEl = document.getElementById('expenseNote');
    if (amtEl) amtEl.value = '';
    if (noteEl) noteEl.value = '';
  }

  // Handle Withdraw From Savings ("استخدام من التحويش")
  handleWithdrawSavings(e) {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('withdrawAmount').value);
    const reason = document.getElementById('withdrawReason').value;

    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ يرجى إدخال مبلغ صحيح');
      return;
    }

    if (amount > this.data.balances.reservedSavings) {
      this.showToast('⚠️ المبلغ المطلوب أكبر من رصيد التحويش المحجوز!');
      return;
    }

    // Transfer from savings to spendable
    this.data.balances.reservedSavings -= amount;
    this.data.balances.spendableBalance += amount;

    // Reset Streak!
    this.data.settings.lastSavingsWithdrawalDate = new Date().toISOString().split('T')[0];

    // Log as a special expense note
    this.data.expenses.unshift({
      id: 'exp_' + Date.now(),
      amount: 0,
      category: 'سحب تحويش',
      note: `سحب ${amount} ج.م من التحويش (سبب: ${reason})`,
      date: new Date().toISOString().split('T')[0]
    });

    this.saveData();
    this.closeModal('withdrawSavingsModal');
    this.updateStreakCount();
    this.renderAll();

    this.showToast('⚠️ تم السحب من التحويش وتحويله للمتاح للصرف. تم إعادة ضبط أيام التماسك (Streak).');
    
    document.getElementById('withdrawAmount').value = '';
    document.getElementById('withdrawReason').value = '';
  }

  // Calculate Rider Shift Net Income & Efficiency
  calculateShiftNet() {
    var orders = parseFloat(document.getElementById('shiftOrders').value) || 0;
    var rate = parseFloat(document.getElementById('shiftRate').value) || 0;
    var bonus = parseFloat(document.getElementById('shiftBonus').value) || 0;
    var tips = parseFloat(document.getElementById('shiftTips').value) || 0;
    var expenses = parseFloat(document.getElementById('shiftExpenses').value) || 0;
    var hours = parseFloat(document.getElementById('shiftHours').value) || 0;
    var km = parseFloat(document.getElementById('shiftKm').value) || 0;

    var gross = (orders * rate) + bonus + tips;
    var net = gross - expenses;

    var netEl = document.getElementById('shiftNetCalcVal');
    var hourlyEl = document.getElementById('shiftHourlyRateVal');
    var kmEl = document.getElementById('shiftKmRateVal');
    var ratioEl = document.getElementById('shiftExpenseRatioVal');

    if (netEl) netEl.textContent = net.toLocaleString('ar-EG') + ' ج.م';

    if (hourlyEl) {
      var hourlyRate = hours > 0 ? (net / hours).toFixed(1) : 0;
      hourlyEl.textContent = hourlyRate + ' ج.م/س';
    }

    if (kmEl) {
      var kmRate = km > 0 ? (net / km).toFixed(1) : 0;
      kmEl.textContent = kmRate + ' ج.م/كم';
    }

    if (ratioEl) {
      var ratio = gross > 0 ? Math.round((expenses / gross) * 100) : 0;
      ratioEl.textContent = ratio + '%';
    }

    return net;
  }

  // Handle Rider Shift Form Submit
  handleRiderShiftSubmit(e) {
    e.preventDefault();
    const net = this.calculateShiftNet();

    if (net <= 0) {
      this.showToast('⚠️ صافي الوردية يجب أن يكون أكبر من صفر');
      return;
    }

    // Pre-fill Income Modal with shift net
    document.getElementById('incomeAmount').value = net;
    document.getElementById('incomeSource').value = 'طلبات';
    const orders = document.getElementById('shiftOrders').value;
    document.getElementById('incomeNote').value = `صافي وردية دليفري (${orders} أوردر)`;

    this.openModal('newIncomeModal');
  }

  // Outings Weekly Spent Calculation
  getWeeklyOutingsSpent() {
    const now = new Date();
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay())); // Sunday as start
    startOfWeek.setHours(0, 0, 0, 0);

    return this.data.expenses
      .filter(exp => exp.category === 'خروجة' && new Date(exp.date) >= startOfWeek)
      .reduce((sum, exp) => sum + exp.amount, 0);
  }

  // Update Outings Budget Config
  updateWeeklyOutingsBudget() {
    const val = parseFloat(document.getElementById('weeklyOutingsInput').value);
    if (!isNaN(val) && val >= 0) {
      this.data.settings.weeklyOutingsBudget = val;
      this.saveData();
      this.renderAll();
      this.showToast('✅ تم تحديث ميزانية الخروجات الأسبوعية بنجاح');
    }
  }

  // Decision Helper ("هل أقدر أصرف؟")
  evaluateCanISpend() {
    const amt = parseFloat(document.getElementById('spendCheckAmount').value);
    const box = document.getElementById('spendDecisionResult');
    const badge = document.getElementById('decisionBadge');
    const text = document.getElementById('decisionText');

    if (isNaN(amt) || amt <= 0) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'flex';
    const spendable = this.data.balances.spendableBalance;
    const outingsRemaining = Math.max(0, this.data.settings.weeklyOutingsBudget - this.getWeeklyOutingsSpent());

    if (amt <= spendable && amt <= outingsRemaining) {
      box.className = 'decision-card decision-green';
      badge.textContent = '🟢 تقدر تصرف وإنت مرتاح';
      text.textContent = `المبلغ (${amt} ج.م) متوفر تماماً في المتاح للصرف وضمن حدود ميزانية خروجاتك الأسبوعية.`;
    } else if (amt <= spendable) {
      box.className = 'decision-card decision-yellow';
      badge.textContent = '🟡 الصرف هيأثر على ميزانية الخروجات';
      text.textContent = `المبلغ متوفر في المتاح للصرف (${spendable} ج.م)، لكنه أكبر من ميزانية الخروجات المتبقية (${outingsRemaining} ج.م). يصرف على مسؤوليتك!`;
    } else {
      box.className = 'decision-card decision-red';
      badge.textContent = '🔴 لا أنصحك بالصرف إطلاقاً!';
      text.textContent = `المبلغ المطلوب (${amt} ج.م) يتجاوز رصيدك المتاح للصرف (${spendable} ج.م). لو صرفت هتحتاج تكسر التحويش 🔒!`;
    }
  }

  // Goal & Debt Handlers
  handleNewGoal(e) {
    e.preventDefault();
    const title = document.getElementById('goalTitle').value;
    const targetAmount = parseFloat(document.getElementById('goalTargetAmount').value);
    const currentAmount = parseFloat(document.getElementById('goalCurrentAmount').value) || 0;

    if (!title || isNaN(targetAmount) || targetAmount <= 0) {
      this.showToast('⚠️ يرجى إدخال اسم المبلغ المطلوب بشكل صحيح');
      return;
    }

    this.data.goals.push({
      id: 'goal_' + Date.now(),
      title,
      targetAmount,
      currentAmount,
      date: new Date().toISOString().split('T')[0]
    });

    this.saveData();
    this.closeModal('newGoalModal');
    this.renderAll();
    this.showToast('✅ تم إضافة الهدف المالي بنجاح');
    document.getElementById('goalTitle').value = '';
    document.getElementById('goalTargetAmount').value = '';
  }

  handleNewDebt(e) {
    e.preventDefault();
    const creditor = document.getElementById('debtTitle').value;
    const totalAmount = parseFloat(document.getElementById('debtTotalAmount').value);
    const paidAmount = parseFloat(document.getElementById('debtPaidAmount').value) || 0;
    const dueDate = document.getElementById('debtDueDate').value || '';

    if (!creditor || isNaN(totalAmount) || totalAmount <= 0) {
      this.showToast('⚠️ يرجى إدخال اسم صاحب الدين والمبلغ الأصلي');
      return;
    }

    this.data.debts.push({
      id: 'debt_' + Date.now(),
      creditor,
      totalAmount,
      paidAmount,
      dueDate
    });

    this.saveData();
    this.closeModal('newDebtModal');
    this.renderAll();
    this.showToast('✅ تم تسجيل الدين بنجاح');
    document.getElementById('debtTitle').value = '';
    document.getElementById('debtTotalAmount').value = '';
  }

  payDebt(debtId) {
    const debt = this.data.debts.find(d => d.id === debtId);
    if (!debt) return;

    const remaining = debt.totalAmount - debt.paidAmount;
    const amtStr = prompt(`أدخل مبلغ السداد للدين (${debt.creditor}) - المتبقي: ${remaining} ج.م:`, remaining);
    const payAmt = parseFloat(amtStr);

    if (!isNaN(payAmt) && payAmt > 0) {
      if (payAmt > this.data.balances.spendableBalance) {
        this.showToast('⚠️ المبلغ المتاح للصرف غير كافٍ لسداد هذا الدين!');
        return;
      }

      debt.paidAmount += payAmt;
      this.data.balances.spendableBalance -= payAmt;

      // Log expense
      this.data.expenses.unshift({
        id: 'exp_' + Date.now(),
        amount: payAmt,
        category: 'ديون',
        note: `سداد جزء من دين ${debt.creditor}`,
        date: new Date().toISOString().split('T')[0]
      });

      this.saveData();
      this.renderAll();
      this.showToast(`✅ تم تسديد ${payAmt} ج.م للدين بنجاح`);
    }
  }

  deleteItem(type, id) {
    if (!confirm('هل أنت متأكد من حذف هذه العملية؟')) return;
    if (type === 'income') {
      this.data.incomes = this.data.incomes.filter(i => i.id !== id);
    } else if (type === 'expense') {
      this.data.expenses = this.data.expenses.filter(e => e.id !== id);
    } else if (type === 'goal') {
      this.data.goals = this.data.goals.filter(g => g.id !== id);
    } else if (type === 'debt') {
      this.data.debts = this.data.debts.filter(d => d.id !== id);
    }
    this.saveData();
    this.renderAll();
    this.showToast('🗑️ تم الحذف بنجاح');
  }

  // Ratios Configuration
  saveRatios() {
    const s = parseFloat(document.getElementById('ratioSavings').value);
    const e = parseFloat(document.getElementById('ratioEssentials').value);
    const o = parseFloat(document.getElementById('ratioOutings').value);

    if (s + e + o !== 100) {
      this.showToast('⚠️ مجموع النسب يجب أن يساوي 100% بالضبط!');
      return;
    }

    this.data.settings.savingsRatio = s;
    this.data.settings.essentialsRatio = e;
    this.data.settings.outingsRatio = o;
    this.saveData();
    this.showToast('✅ تم حفظ نسب تقسيم القبض بنجاح');
  }

  // Data Import/Export/Reset
  exportData() {
    const jsonStr = JSON.stringify(this.data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BH_Finance_Backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('📦 تم تصدير النسخة الاحتياطية بنجاح');
  }

  importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.balances && imported.incomes) {
          this.data = imported;
          this.saveData();
          this.renderAll();
          this.showToast('🎉 تم استعادة البيانات بنجاح!');
        } else {
          this.showToast('⚠️ ملف البيانات غير صالح');
        }
      } catch (err) {
        this.showToast('⚠️ حدث خطأ أثناء قراءة الملف');
      }
    };
    reader.readAsText(file);
  }

  confirmResetData() {
    if (confirm('⚠️ هل أنت متأكد تماماً من تصفير وحذف جميع بيانات التطبيق؟ لا يمكن التراجع عن هذا الإجراء!')) {
      localStorage.removeItem(STORAGE_KEY);
      this.data = this.getDefaultData();
      this.saveData();
      this.renderAll();
      this.showToast('🧹 تم تصفير البيانات بنجاح');
    }
  }

  // Render Master Logic
  renderAll() {
    this.renderBalances();
    this.renderPendingIncomes();
    this.renderOutingsWidget();
    this.renderQuickStats();
    this.renderVariableIncomeStats();
    this.renderRecentTransactions();
    this.renderIncomeHistory();
    this.renderExpenseHistory();
    this.renderGoals();
    this.renderDebts();
    this.calculateFutureSimulation();
  }

  // Render Pending Incomes Card & Items
  renderPendingIncomes() {
    const list = this.data.pendingIncomes || [];
    const card = document.getElementById('pendingIncomesCard');
    const container = document.getElementById('dashboardPendingList');
    const badge = document.getElementById('pendingCountBadge');
    const totalValEl = document.getElementById('pendingTotalAmountVal');

    if (!card) return;

    if (list.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';

    const totalAmt = list.reduce((sum, i) => sum + i.amount, 0);
    if (totalValEl) totalValEl.textContent = totalAmt.toLocaleString('ar-EG') + ' ج.م';
    if (badge) badge.textContent = `${list.length} عمليات منتظرة`;

    if (!container) return;

    container.innerHTML = list.map(item => `
      <div class="list-item" style="border-right: 3px solid var(--essentials);">
        <div class="item-main">
          <div class="item-icon outing">⏳</div>
          <div class="item-details">
            <span class="item-title">${item.source} — ${item.amount.toLocaleString()} ج.م</span>
            <span class="item-sub">${item.notes || 'قبض منتظر'} • ${item.date}</span>
          </div>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn btn-savings btn-sm" onclick="app.confirmPendingIncome('${item.id}')">✅ تم الاستلام</button>
          <button class="delete-btn" onclick="app.deletePendingIncome('${item.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderBalances() {
    const reserved = this.data.balances.reservedSavings;
    const spendable = this.data.balances.spendableBalance;
    const total = reserved + spendable;

    document.getElementById('totalBalanceVal').textContent = total.toLocaleString();
    document.getElementById('reservedSavingsVal').textContent = reserved.toLocaleString();
    document.getElementById('spendableBalanceVal').textContent = spendable.toLocaleString();
  }

  renderOutingsWidget() {
    const budget = this.data.settings.weeklyOutingsBudget;
    const spent = this.getWeeklyOutingsSpent();
    const remaining = Math.max(0, budget - spent);
    const percent = Math.min(100, Math.round((spent / budget) * 100)) || 0;

    const fill = document.getElementById('outingsProgressFill');
    if (fill) fill.style.width = percent + '%';

    document.getElementById('outingsBudgetStatus').textContent = `${spent} من ${budget} ج.م`;
    document.getElementById('outingsRemainingVal').textContent = `${remaining} ج.م`;
    document.getElementById('outingsUsagePercent').textContent = `${percent}% مستهلك`;

    const detailText = document.getElementById('outingsBudgetDetailText');
    if (detailText) detailText.textContent = `المصروف هذا الأسبوع: ${spent} ج.م من أصل ${budget} ج.م`;
  }

  renderQuickStats() {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Weekly Expenses
    const startOfWeek = new Date(now.setDate(now.getDate() - now.getDay()));
    startOfWeek.setHours(0,0,0,0);

    const weeklyExp = this.data.expenses
      .filter(e => new Date(e.date) >= startOfWeek)
      .reduce((sum, e) => sum + e.amount, 0);

    // Monthly Income & Expenses
    const monthlyInc = this.data.incomes
      .filter(i => {
        const d = new Date(i.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, i) => sum + i.amount, 0);

    const monthlyExp = this.data.expenses
      .filter(e => {
        const d = new Date(e.date);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      })
      .reduce((sum, e) => sum + e.amount, 0);

    document.getElementById('weeklyExpensesVal').textContent = weeklyExp.toLocaleString();
    document.getElementById('totalSavedVal').textContent = this.data.balances.reservedSavings.toLocaleString();
    document.getElementById('monthlyIncomeVal').textContent = monthlyInc.toLocaleString();
    document.getElementById('monthlyExpensesVal').textContent = monthlyExp.toLocaleString();
  }

  renderVariableIncomeStats() {
    const incomes = this.data.incomes;
    if (incomes.length === 0) {
      document.getElementById('lastIncomeVal').textContent = '0 ج.م';
      document.getElementById('avgIncomeVal').textContent = '0 ج.م';
      document.getElementById('maxIncomeVal').textContent = '0 ج.م';
      document.getElementById('minIncomeVal').textContent = '0 ج.م';
      return;
    }

    const last = incomes[0].amount;
    const amounts = incomes.map(i => i.amount);
    const sum = amounts.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / amounts.length);
    const max = Math.max(...amounts);
    const min = Math.min(...amounts);

    document.getElementById('lastIncomeVal').textContent = `${last.toLocaleString()} ج.م`;
    document.getElementById('avgIncomeVal').textContent = `${avg.toLocaleString()} ج.م`;
    document.getElementById('maxIncomeVal').textContent = `${max.toLocaleString()} ج.م`;
    document.getElementById('minIncomeVal').textContent = `${min.toLocaleString()} ج.م`;
  }

  renderRecentTransactions() {
    const list = document.getElementById('recentTransactionsList');
    if (!list) return;

    // Combine recent incomes and expenses
    const combined = [
      ...this.data.incomes.map(i => ({ ...i, itemType: 'income' })),
      ...this.data.expenses.map(e => ({ ...e, itemType: 'expense' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    if (combined.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📝</div>لا توجد عمليات مسجلة بعد</div>`;
      return;
    }

    list.innerHTML = combined.map(item => {
      const isInc = item.itemType === 'income';
      const iconClass = isInc ? 'income' : (item.category === 'خروجة' ? 'outing' : 'expense');
      const iconSymbol = isInc ? '💵' : (item.category === 'خروجة' ? '❤️' : '💸');
      const amountSign = isInc ? '+' : '-';
      const colorClass = isInc ? 'positive' : 'negative';

      return `
        <div class="list-item">
          <div class="item-main">
            <div class="item-icon ${iconClass}">${iconSymbol}</div>
            <div class="item-details">
              <span class="item-title">${isInc ? 'قبض: ' + item.source : item.category}</span>
              <span class="item-sub">${item.date} ${item.notes || item.note ? '• ' + (item.notes || item.note) : ''}</span>
            </div>
          </div>
          <div class="item-amount ${colorClass}">${amountSign}${item.amount.toLocaleString()} ج.م</div>
        </div>
      `;
    }).join('');
  }

  renderIncomeHistory() {
    const container = document.getElementById('incomeHistoryList');
    if (!container) return;

    if (this.data.incomes.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💵</div>لا يوجد قبض مسجل بعد</div>`;
      return;
    }

    container.innerHTML = this.data.incomes.map(inc => `
      <div class="list-item">
        <div class="item-main">
          <div class="item-icon income">💵</div>
          <div class="item-details">
            <span class="item-title">قبض (${inc.source})</span>
            <span class="item-sub">${inc.date} ${inc.notes ? '• ' + inc.notes : ''}</span>
            <small style="color: var(--text-muted); font-size: 0.72rem;">🔒تحويش: ${inc.savingsAmt} | 💳متاح: ${inc.essentialsAmt + inc.outingsAmt}</small>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <span class="item-amount positive">+${inc.amount.toLocaleString()} ج.م</span>
          <button class="delete-btn" onclick="app.deleteItem('income', '${inc.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderExpenseHistory() {
    const container = document.getElementById('expenseHistoryList');
    if (!container) return;

    if (this.data.expenses.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">💳</div>لا توجد مصاريف مسجلة بعد</div>`;
      return;
    }

    container.innerHTML = this.data.expenses.map(exp => `
      <div class="list-item">
        <div class="item-main">
          <div class="item-icon ${exp.category === 'خروجة' ? 'outing' : 'expense'}">${exp.category === 'خروجة' ? '❤️' : '💸'}</div>
          <div class="item-details">
            <span class="item-title">${exp.category}</span>
            <span class="item-sub">${exp.date} ${exp.note ? '• ' + exp.note : ''}</span>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <span class="item-amount negative">-${exp.amount.toLocaleString()} ج.م</span>
          <button class="delete-btn" onclick="app.deleteItem('expense', '${exp.id}')" title="حذف">🗑️</button>
        </div>
      </div>
    `).join('');
  }

  renderGoals() {
    const container = document.getElementById('goalsList');
    if (!container) return;

    if (this.data.goals.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎯</div>لا توجد أهداف أضفتها بعد</div>`;
      return;
    }

    container.innerHTML = this.data.goals.map(goal => {
      const remaining = Math.max(0, goal.targetAmount - goal.currentAmount);
      const percent = Math.min(100, Math.round((goal.currentAmount / goal.targetAmount) * 100)) || 0;

      return `
        <div class="list-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="color: #fff;">🎯 ${goal.title}</strong>
            <button class="delete-btn" onclick="app.deleteItem('goal', '${goal.id}')">🗑️</button>
          </div>
          <div class="progress-bar-container" style="margin: 2px 0;">
            <div class="progress-fill fill-savings" style="width: ${percent}%;"></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-muted);">
            <span>المحجوز: <strong class="val-savings">${goal.currentAmount.toLocaleString()} ج.م</strong></span>
            <span>المحتجز المطلوب: ${goal.targetAmount.toLocaleString()} ج.m (${percent}%)</span>
          </div>
        </div>
      `;
    }).join('');
  }

  renderDebts() {
    const container = document.getElementById('debtsList');
    if (!container) return;

    let totalRemaining = 0;

    if (this.data.debts.length === 0) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📌</div>لا توجد ديون مسجلة. عظيم!</div>`;
      document.getElementById('totalDebtsRemainingVal').textContent = '0 ج.م';
      return;
    }

    container.innerHTML = this.data.debts.map(debt => {
      const remaining = debt.totalAmount - debt.paidAmount;
      totalRemaining += Math.max(0, remaining);

      return `
        <div class="list-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong style="color: #fff;">📌 ${debt.creditor}</strong>
              <div style="font-size: 0.75rem; color: var(--text-muted);">استحقاق: ${debt.dueDate || 'غير محدد'}</div>
            </div>
            <div style="display: flex; gap: 6px;">
              ${remaining > 0 ? `<button class="btn btn-primary btn-sm" onclick="app.payDebt('${debt.id}')">سداد جزء</button>` : `<span class="streak-badge">تم السداد بالكامل ✅</span>`}
              <button class="delete-btn" onclick="app.deleteItem('debt', '${debt.id}')">🗑️</button>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-top: 4px;">
            <span>الأصلي: ${debt.totalAmount.toLocaleString()} ج.م</span>
            <span>المسدد: ${debt.paidAmount.toLocaleString()} ج.م</span>
            <span style="color: var(--danger); font-weight: 800;">المتبقي: ${remaining.toLocaleString()} ج.م</span>
          </div>
        </div>
      `;
    }).join('');

    document.getElementById('totalDebtsRemainingVal').textContent = `${totalRemaining.toLocaleString()} ج.م`;
  }

  // Financial Future Simulator ("مستقبلي المالي")
  calculateFutureSimulation() {
    const weeklyInput = document.getElementById('simWeeklySavings');
    const currentInput = document.getElementById('simCurrentBalance');

    if (!weeklyInput || !currentInput) return;

    let weekly = parseFloat(weeklyInput.value);
    let current = parseFloat(currentInput.value);

    // Default fallbacks if empty or invalid
    if (isNaN(weekly)) {
      weekly = 1000;
    }

    if (isNaN(current)) {
      current = (this.data.balances.reservedSavings + this.data.balances.spendableBalance) || 3000;
    }

    // Timeline Projections
    const m1 = Math.round(current + (weekly * 4));
    const m3 = Math.round(current + (weekly * 12));
    const m6 = Math.round(current + (weekly * 26));
    const y1 = Math.round(current + (weekly * 52));

    const m1El = document.getElementById('sim1MonthVal');
    const m3El = document.getElementById('sim3MonthsVal');
    const m6El = document.getElementById('sim6MonthsVal');
    const y1El = document.getElementById('sim1YearVal');

    if (m1El) m1El.textContent = `≈ ${m1.toLocaleString()} ج.م`;
    if (m3El) m3El.textContent = `≈ ${m3.toLocaleString()} ج.م`;
    if (m6El) m6El.textContent = `≈ ${m6.toLocaleString()} ج.م`;
    if (y1El) y1El.textContent = `≈ ${y1.toLocaleString()} ج.م`;

    // Scenarios (after 1 year = 52 weeks)
    const strongWeekly = Math.round(weekly * 1.2);
    const strongTotal = Math.round(current + (strongWeekly * 52));

    const mediumWeekly = Math.round(weekly * 1.0);
    const mediumTotal = Math.round(current + (mediumWeekly * 52));

    const weakWeekly = Math.round(weekly * 0.7);
    const weakTotal = Math.round(current + (weakWeekly * 52));

    const sW = document.getElementById('simStrongWeekly');
    const sV = document.getElementById('simStrongVal');

    const mW = document.getElementById('simMediumWeekly');
    const mV = document.getElementById('simMediumVal');

    const wW = document.getElementById('simWeakWeekly');
    const wV = document.getElementById('simWeakVal');

    if (sW) sW.textContent = strongWeekly.toLocaleString();
    if (sV) sV.textContent = `≈ ${strongTotal.toLocaleString()} ج.م`;

    if (mW) mW.textContent = mediumWeekly.toLocaleString();
    if (mV) mV.textContent = `≈ ${mediumTotal.toLocaleString()} ج.م`;

    if (wW) wW.textContent = weakWeekly.toLocaleString();
    if (wV) wV.textContent = `≈ ${weakTotal.toLocaleString()} ج.م`;
  }

  // HTML5 Canvas Chart Rendering
  renderReportChart() {
    const canvas = document.getElementById('financeReportChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.offsetWidth || 340;
    const height = 180;
    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    const monthlyInc = parseFloat(document.getElementById('monthlyIncomeVal').textContent.replace(/,/g, '')) || 0;
    const monthlyExp = parseFloat(document.getElementById('monthlyExpensesVal').textContent.replace(/,/g, '')) || 0;
    const reserved = this.data.balances.reservedSavings;

    const maxVal = Math.max(monthlyInc, monthlyExp, reserved, 1000);

    const barWidth = 45;
    const gap = 40;
    const startX = (width - (3 * barWidth + 2 * gap)) / 2;

    const items = [
      { label: 'الدخل', value: monthlyInc, color: '#06b6d4' },
      { label: 'المصاريف', value: monthlyExp, color: '#ef4444' },
      { label: 'التحويش', value: reserved, color: '#10b981' }
    ];

    items.forEach((item, idx) => {
      const x = startX + idx * (barWidth + gap);
      const barHeight = (item.value / maxVal) * (height - 50);
      const y = height - 30 - barHeight;

      // Draw Bar
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 6);
      ctx.fill();

      // Draw Value
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Cairo';
      ctx.textAlign = 'center';
      ctx.fillText(item.value.toLocaleString(), x + barWidth / 2, y - 6);

      // Draw Label
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Cairo';
      ctx.fillText(item.label, x + barWidth / 2, height - 10);
    });
  }

  // ═══════════════════════════════════════════
  // GitHub Update System
  // ═══════════════════════════════════════════

  get GITHUB_API()  { return 'https://api.github.com/repos/mhmoudmohmed269-cmd/-bh/commits?per_page=1'; }
  get GITHUB_RAW()  { return 'https://raw.githubusercontent.com/mhmoudmohmed269-cmd/-bh/main'; }
  get UPDATE_KEY()  { return 'BH_LAST_COMMIT_SHA'; }

  initUpdateUI() {
    var savedSHA = localStorage.getItem(this.UPDATE_KEY);
    var versionLabel = document.getElementById('currentVersionLabel');
    if (versionLabel) {
      versionLabel.textContent = savedSHA ? 'v' + savedSHA.substring(0, 7) : 'غير محدد';
    }

    var notifyBtn = document.getElementById('notifyPermissionBtn');
    if (notifyBtn && 'Notification' in window) {
      if (Notification.permission === 'granted') {
        notifyBtn.textContent = '🔔 الإشعارات مفعلة ✅';
        notifyBtn.className = 'btn btn-secondary btn-full btn-sm';
      } else if (Notification.permission === 'denied') {
        notifyBtn.textContent = '🔕 الإشعارات محظورة في المتصفح';
      } else {
        notifyBtn.textContent = '🔔 تفعيل إشعارات التحديثات';
      }
    }
  }

  async toggleNotifications() {
    if (!('Notification' in window)) {
      this.showToast('⚠️ المتصفح لا يدعم إشعارات النظام', 'error');
      return;
    }

    if (Notification.permission === 'granted') {
      this.showToast('🔔 الإشعارات مفعلة بالفعل للتحديثات!', 'info');
      return;
    }

    if (Notification.permission === 'denied') {
      this.showToast('🔕 الإشعارات محظورة. يرجى تفعيلها من إعدادات المتصفح', 'error');
      return;
    }

    try {
      var permission = await Notification.requestPermission();
      this.initUpdateUI();
      if (permission === 'granted') {
        this.showToast('🎉 تم تفعيل إشعارات التحديث بنجاح!', 'success');
        try {
          new Notification('🔔 تطبيق BH', {
            body: 'تم تفعيل إشعارات التحديثات بنجاح!',
            icon: 'icon-192.png'
          });
        } catch (e) {}
      } else {
        this.showToast('⚠️ لم يتم منح إذن الإشعارات', 'info');
      }
    } catch (e) {
      console.error('Notification permission error:', e);
    }
  }

  autoCheckUpdates() {
    // Check 5 seconds after launch silently
    setTimeout(() => {
      this.checkForUpdates(true);
    }, 5000);

    // Check periodically every 30 minutes
    setInterval(() => {
      this.checkForUpdates(true);
    }, 30 * 60 * 1000);
  }

  async checkForUpdates(isSilent) {
    var btn = document.getElementById('checkUpdateBtn');
    var statusBox = document.getElementById('updateStatus');
    var statusIcon = document.getElementById('updateStatusIcon');
    var statusText = document.getElementById('updateStatusText');
    var applyBtn = document.getElementById('applyUpdateBtn');

    if (!isSilent && btn) {
      btn.innerHTML = '⏳ جاري التحقق...';
      btn.disabled = true;
    }

    try {
      var response = await fetch(this.GITHUB_API);

      if (!response.ok) throw new Error('HTTP ' + response.status);

      var rawData = await response.json();
      var data = Array.isArray(rawData) ? rawData[0] : rawData;
      if (!data || !data.sha) throw new Error('لم يتم العثور على بيانات التحديث');

      var latestSHA = data.sha;
      var savedSHA = localStorage.getItem(this.UPDATE_KEY);
      var commitMsg = (data.commit && data.commit.message) ? data.commit.message : 'تحديث جديد';
      var rawDate = data.commit && data.commit.committer && data.commit.committer.date;
      var commitDate = rawDate
        ? new Date(rawDate).toLocaleDateString('ar-EG', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
          })
        : '';

      if (statusBox) statusBox.style.display = 'flex';

      if (savedSHA && savedSHA === latestSHA) {
        if (statusBox) {
          statusBox.className = 'decision-card decision-green';
          statusIcon.textContent = '✅';
          statusText.innerHTML = 'التطبيق محدث لآخر نسخة<br><span style="font-size:.72rem;opacity:.7;">' + commitDate + '</span>';
        }
        if (applyBtn) applyBtn.style.display = 'none';
        if (!isSilent) this.showToast('✅ التطبيق محدث بالفعل!', 'success');
      } else {
        if (statusBox) {
          statusBox.className = 'decision-card decision-yellow';
          statusIcon.textContent = '🆕';
          statusText.innerHTML = 'تحديث جديد متاح!<br><span style="font-size:.72rem;opacity:.7;">' + commitMsg.substring(0, 60) + '</span><br><span style="font-size:.68rem;opacity:.6;">' + commitDate + '</span>';
        }
        if (applyBtn) applyBtn.style.display = 'flex';
        this._pendingUpdateSHA = latestSHA;

        // Trigger Notification
        if (window.Notification && Notification.permission === 'granted') {
          if (this._lastNotifiedSHA !== latestSHA) {
            this._lastNotifiedSHA = latestSHA;
            try {
              var notif = new Notification('🆕 تحديث جديد متاح لتطبيق BH', {
                body: commitMsg,
                icon: 'icon-192.png',
                tag: 'bh-update-' + latestSHA
              });
              notif.onclick = function() {
                window.focus();
                if (window.app) window.app.switchTab('moreView');
              };
            } catch (e) {
              console.log('Notification trigger error:', e);
            }
          }
        }

        this.showToast('🔔 يوجد تحديث جديد متاح للتطبيق!', 'info');
      }
    } catch (err) {
      console.error('Update check failed:', err);
      if (!isSilent) {
        if (statusBox) {
          statusBox.style.display = 'flex';
          statusBox.className = 'decision-card decision-red';
          statusIcon.textContent = '❌';
          statusText.innerHTML = 'فشل التحقق<br><span style="font-size:.7rem;opacity:.6;">(' + err.message + ')</span>';
        }
        if (applyBtn) applyBtn.style.display = 'none';
        this.showToast('❌ فشل — ' + err.message, 'error');
      }
    } finally {
      if (!isSilent && btn) {
        btn.innerHTML = '🔍 تحقق من التحديثات';
        btn.disabled = false;
      }
    }
  }

  async applyUpdate() {
    var applyBtn = document.getElementById('applyUpdateBtn');
    var statusIcon = document.getElementById('updateStatusIcon');
    var statusText = document.getElementById('updateStatusText');
    var statusBox = document.getElementById('updateStatus');

    applyBtn.innerHTML = '⏳ جاري التحديث...';
    applyBtn.disabled = true;
    statusBox.className = 'decision-card decision-yellow';
    statusIcon.textContent = '⏳';
    statusText.textContent = 'جاري تحميل التحديث...';

    try {
      // 1. Clear all service worker caches
      if ('caches' in window) {
        var cacheNames = await caches.keys();
        for (var i = 0; i < cacheNames.length; i++) {
          await caches.delete(cacheNames[i]);
        }
      }

      // 2. Unregister service worker
      if ('serviceWorker' in navigator) {
        var registrations = await navigator.serviceWorker.getRegistrations();
        for (var j = 0; j < registrations.length; j++) {
          await registrations[j].unregister();
        }
      }

      // 3. Save the new commit SHA
      if (this._pendingUpdateSHA) {
        localStorage.setItem(this.UPDATE_KEY, this._pendingUpdateSHA);
      }

      statusIcon.textContent = '✅';
      statusText.textContent = 'تم التحديث! جاري إعادة التحميل...';
      statusBox.className = 'decision-card decision-green';
      this.showToast('✅ تم التحديث بنجاح!', 'success');

      // 4. Hard reload
      setTimeout(function() {
        window.location.reload(true);
      }, 1200);

    } catch (err) {
      console.error('Update failed:', err);
      statusIcon.textContent = '❌';
      statusText.textContent = 'فشل التحديث — حاول مرة ثانية';
      statusBox.className = 'decision-card decision-red';
      applyBtn.innerHTML = '⬇️ حدّث الآن';
      applyBtn.disabled = false;
      this.showToast('❌ فشل التحديث', 'error');
    }
  }

  // Save current version on first load
  async saveInitialVersion() {
    var savedSHA = localStorage.getItem(this.UPDATE_KEY);
    if (!savedSHA) {
      try {
        var response = await fetch(this.GITHUB_API);
        if (response.ok) {
          var rawData = await response.json();
          var data = Array.isArray(rawData) ? rawData[0] : rawData;
          if (data && data.sha) {
            localStorage.setItem(this.UPDATE_KEY, data.sha);
            this.initUpdateUI();
          }
        }
      } catch (e) {
        // Offline — skip
      }
    }
  }
  // ============================================================
  //  SMART FINANCIAL ALARM SYSTEM
  // ============================================================

  /**
   * Load alarm settings from localStorage into the UI
   */
  initSmartAlarm() {
    const alarm = this.data.settings.smartAlarm;
    if (!alarm) return;

    // Restore checkboxes
    const cbLow = document.getElementById('condLowBalance');
    const cbPending = document.getElementById('condPendingIncomes');
    const cbAlways = document.getElementById('condAlwaysAlarm');
    const timeEl = document.getElementById('alarmTime');
    if (cbLow) cbLow.checked = !!alarm.condLowBalance;
    if (cbPending) cbPending.checked = !!alarm.condPendingIncomes;
    if (cbAlways) cbAlways.checked = !!alarm.condAlwaysAlarm;
    if (timeEl && alarm.time) timeEl.value = alarm.time;
    if (alarm.threshold != null) {
      const tEl = document.getElementById('alarmLowBalanceThreshold');
      if (tEl) tEl.value = alarm.threshold;
    }

    // Restore days
    const activeDays = alarm.days || [0,1,2,3,4,5];
    document.querySelectorAll('#alarmDaysRow .day-btn').forEach(btn => {
      const day = parseInt(btn.getAttribute('data-day'));
      btn.classList.toggle('active', activeDays.includes(day));
    });

    // Restore active state UI
    if (alarm.active) {
      this._showAlarmActiveUI(alarm);
    }

    this.updateAlarmPreview();

    // Arm the ticker to fire the alarm if active
    if (alarm.active) {
      this._armAlarmTicker();
    }
  }

  /**
   * Toggle a day button on/off
   */
  toggleAlarmDay(btn) {
    btn.classList.toggle('active');
    this.updateAlarmPreview();
  }

  /**
   * Collect selected days as an array of integers
   */
  _getSelectedDays() {
    const days = [];
    document.querySelectorAll('#alarmDaysRow .day-btn').forEach(btn => {
      if (btn.classList.contains('active')) {
        days.push(parseInt(btn.getAttribute('data-day')));
      }
    });
    return days;
  }

  /**
   * Live preview of the alarm description
   */
  updateAlarmPreview() {
    const condLow = document.getElementById('condLowBalance')?.checked;
    const condPending = document.getElementById('condPendingIncomes')?.checked;
    const condAlways = document.getElementById('condAlwaysAlarm')?.checked;
    const timeVal = document.getElementById('alarmTime')?.value || '06:00';
    const threshold = parseFloat(document.getElementById('alarmLowBalanceThreshold')?.value || 200);

    const banner = document.getElementById('alarmPreviewBanner');
    const previewText = document.getElementById('alarmPreviewText');
    if (!banner || !previewText) return;

    const reasons = [];
    if (condAlways) reasons.push('📅 يومياً بشكل ثابت');
    if (condLow) reasons.push(`💳 لو الرصيد أقل من ${threshold} ج.م`);
    if (condPending) reasons.push('⏳ لو عندك قبض منتظر');

    if (reasons.length === 0) {
      banner.style.display = 'none';
      return;
    }

    const [h, m] = timeVal.split(':');
    const hourNum = parseInt(h);
    const period = hourNum < 12 ? 'صباحاً' : 'مساءً';
    const displayH = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
    const timeDisplay = `${displayH}:${m} ${period}`;

    banner.style.display = 'block';
    previewText.textContent = `📢 المنبه سيرن الساعة ${timeDisplay} — ${reasons.join(' / ')}`;
  }

  /**
   * Check right now if alarm conditions are met
   */
  _checkAlarmConditions(alarm) {
    if (alarm.condAlwaysAlarm) return { fire: true, reason: '📅 وقت الاستيقاظ اليومي المحدد' };

    if (alarm.condLowBalance) {
      const spendable = this.data.balances.spendableBalance || 0;
      const threshold = parseFloat(alarm.threshold) || 200;
      if (spendable < threshold) {
        return { fire: true, reason: `💳 رصيدك المتاح (${spendable.toFixed(0)} ج.م) أقل من ${threshold} ج.م — وقت الشغل!` };
      }
    }

    if (alarm.condPendingIncomes) {
      const hasPending = this.data.pendingIncomes && this.data.pendingIncomes.length > 0;
      if (hasPending) {
        const total = this.data.pendingIncomes.reduce((s, p) => s + (p.amount || 0), 0);
        return { fire: true, reason: `⏳ عندك ${this.data.pendingIncomes.length} قبض قيد الانتظار بإجمالي ${total.toFixed(0)} ج.م — اصحى واقبض فلوسك!` };
      }
    }

    return { fire: false, reason: '' };
  }

  /**
   * Arms a setInterval ticker that checks the time every minute
   */
  _armAlarmTicker() {
    if (this._alarmInterval) clearInterval(this._alarmInterval);

    this._alarmInterval = setInterval(() => {
      const alarm = this.data.settings.smartAlarm;
      if (!alarm || !alarm.active) {
        clearInterval(this._alarmInterval);
        return;
      }

      const now = new Date();
      const currentDay = now.getDay();
      const currentH = now.getHours().toString().padStart(2, '0');
      const currentM = now.getMinutes().toString().padStart(2, '0');
      const currentTime = `${currentH}:${currentM}`;

      // Check if today is an active day
      if (!alarm.days.includes(currentDay)) return;

      // Check if time matches
      if (currentTime !== alarm.time) return;

      // Avoid double-firing in the same minute
      const todayKey = `${now.toISOString().split('T')[0]}_${alarm.time}`;
      if (localStorage.getItem('BH_ALARM_FIRED') === todayKey) return;
      localStorage.setItem('BH_ALARM_FIRED', todayKey);

      // Check conditions
      const { fire, reason } = this._checkAlarmConditions(alarm);
      if (fire) {
        this._fireAlarm(reason);
      }
    }, 30000); // check every 30s
  }

  /**
   * Fire the alarm — sound + notification + toast
   */
  _fireAlarm(reason) {
    // Play alarm sound via AudioContext
    this._playAlarmSound();

    // Show in-app toast
    this.showToast(`⏰ ${reason}`, 'info');

    // Show system notification if permission granted
    if (Notification.permission === 'granted') {
      const notif = new Notification('⏰ BH — منبه ذكي', {
        body: reason,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag: 'bh-smart-alarm',
        requireInteraction: true,
        vibrate: [500, 200, 500, 200, 500]
      });
      notif.onclick = () => { window.focus(); notif.close(); };
    }
  }

  /**
   * Play alarm beeps using Web Audio API
   */
  _playAlarmSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playBeep = (startTime, freq = 880, duration = 0.3) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.6, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
      };
      // Play 4 beeps
      [0, 0.4, 0.8, 1.2].forEach(t => playBeep(ctx.currentTime + t));
    } catch (e) {
      console.warn('Audio play failed:', e);
    }
  }

  /**
   * Calculate the next alarm date/time string for display
   */
  _getNextAlarmLabel(alarm) {
    if (!alarm || !alarm.active || !alarm.days || alarm.days.length === 0) return '—';
    const now = new Date();
    const [h, m] = alarm.time.split(':').map(Number);

    for (let i = 0; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const day = d.getDay();
      if (!alarm.days.includes(day)) continue;
      d.setHours(h, m, 0, 0);
      if (d > now) {
        const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
        const period = h < 12 ? 'صباحاً' : 'مساءً';
        const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `${dayNames[day]} — ${displayH}:${m.toString().padStart(2,'0')} ${period}`;
      }
    }
    return '—';
  }

  /**
   * Show active alarm UI state
   */
  _showAlarmActiveUI(alarm) {
    const badge = document.getElementById('alarmStatusBadge');
    const activateBtn = document.getElementById('activateAlarmBtn');
    const cancelBtn = document.getElementById('cancelAlarmBtn');
    const nextInfo = document.getElementById('nextAlarmInfo');
    const nextLabel = document.getElementById('nextAlarmTimeLabel');

    if (badge) { badge.textContent = '✅ مفعّل'; badge.style.background = 'rgba(0,217,100,0.25)'; badge.style.color = '#00d964'; }
    if (activateBtn) activateBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    if (nextInfo) nextInfo.style.display = 'block';
    if (nextLabel) nextLabel.textContent = this._getNextAlarmLabel(alarm);
  }

  /**
   * Reset alarm UI to inactive state
   */
  _showAlarmInactiveUI() {
    const badge = document.getElementById('alarmStatusBadge');
    const activateBtn = document.getElementById('activateAlarmBtn');
    const cancelBtn = document.getElementById('cancelAlarmBtn');
    const nextInfo = document.getElementById('nextAlarmInfo');

    if (badge) { badge.textContent = 'غير مفعل'; badge.style.background = 'rgba(100,100,100,0.25)'; badge.style.color = ''; }
    if (activateBtn) activateBtn.style.display = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (nextInfo) nextInfo.style.display = 'none';
  }

  /**
   * Activate the smart alarm — saves settings & requests notification permission
   * Also sends SCHEDULE_ALARM message to the Service Worker for background firing.
   */
  async activateSmartAlarm() {
    const time = document.getElementById('alarmTime')?.value;
    if (!time) { this.showToast('⚠️ اختار وقت المنبه الأول'); return; }

    const condLow = document.getElementById('condLowBalance')?.checked;
    const condPending = document.getElementById('condPendingIncomes')?.checked;
    const condAlways = document.getElementById('condAlwaysAlarm')?.checked;
    const threshold = parseFloat(document.getElementById('alarmLowBalanceThreshold')?.value || 200);
    const days = this._getSelectedDays();

    if (!condLow && !condPending && !condAlways) {
      this.showToast('⚠️ اختار على الأقل شرط واحد للمنبه'); return;
    }
    if (days.length === 0) {
      this.showToast('⚠️ اختار على الأقل يوم واحد'); return;
    }

    // Request notification permission (required for SW notifications)
    let notifGranted = false;
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      notifGranted = perm === 'granted';
    }

    if (!notifGranted) {
      this.showToast('⚠️ لازم تسمح بالإشعارات عشان المنبه يشتغل وهو التطبيق مقفول', 'error');
      return;
    }

    const alarm = { active: true, time, condLowBalance: condLow, condPendingIncomes: condPending, condAlwaysAlarm: condAlways, threshold, days };
    this.data.settings.smartAlarm = alarm;
    this.saveData();

    this._showAlarmActiveUI(alarm);
    this._armAlarmTicker();

    // ── Schedule via Service Worker (fires even when app is closed) ──
    await this._scheduleSwAlarm(alarm);

    this.showToast('⏰ المنبه الذكي اتفعّل! هيصحيك حتى لو التطبيق مقفول 🔔', 'success');
  }

  /**
   * Deactivate / cancel the smart alarm
   */
  cancelSmartAlarm() {
    if (this._alarmInterval) clearInterval(this._alarmInterval);
    this.data.settings.smartAlarm = { active: false };
    this.saveData();
    this._showAlarmInactiveUI();
    // Tell SW to cancel scheduled notifications
    this._sendSwMessage({ action: 'CANCEL_ALARM' });
    this.showToast('🔕 تم إلغاء المنبه الذكي');
  }

  /**
   * Calculate next 7 alarm timestamps (one per active day within next 7 days)
   * Used to pre-schedule SW notifications
   */
  _getNextAlarmTimestamps(alarm, maxDays = 7) {
    const [h, m] = alarm.time.split(':').map(Number);
    const now = new Date();
    const timestamps = [];

    for (let i = 0; i <= maxDays; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      if (alarm.days.includes(d.getDay()) && d > now) {
        timestamps.push(d.getTime());
      }
    }
    return timestamps;
  }

  /**
   * Build the alarm reason string for SW notification body
   */
  _buildAlarmReason(alarm) {
    const reasons = [];
    if (alarm.condAlwaysAlarm) reasons.push('📅 وقت الاستيقاظ اليومي');
    if (alarm.condLowBalance) reasons.push(`💳 راجع رصيدك — تحت ${alarm.threshold} ج.م`);
    if (alarm.condPendingIncomes) reasons.push('⏳ عندك قبض قيد الانتظار — اصحى واقبض فلوسك!');
    return reasons.join(' | ') || '⏰ وقت الاستيقاظ';
  }

  /**
   * Send a message to the active Service Worker
   */
  async _sendSwMessage(data) {
    try {
      if ('serviceWorker' in navigator) {
        const sw = navigator.serviceWorker.controller ||
          (await navigator.serviceWorker.ready).active;
        if (sw) sw.postMessage(data);
      }
    } catch (e) {
      console.warn('Could not message SW:', e);
    }
  }

  /**
   * Schedule alarm notifications via Service Worker (background-safe)
   */
  async _scheduleSwAlarm(alarm) {
    const timestamps = this._getNextAlarmTimestamps(alarm);
    if (timestamps.length === 0) return;
    const reason = this._buildAlarmReason(alarm);
    await this._sendSwMessage({
      action: 'SCHEDULE_ALARM',
      timestamps,
      reason,
      title: '⏰ BH — منبه ذكي'
    });
  }
}

// Global App Instance
let app;
window.addEventListener('DOMContentLoaded', function() {
  app = new BHApp();
  app.initUpdateUI();
  app.saveInitialVersion();
  app.autoCheckUpdates();
  app.initSmartAlarm();
});
