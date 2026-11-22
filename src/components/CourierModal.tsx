import React, { useState, useEffect } from 'react';
import { 
  X, 
  Save, 
  UserCheck,
  KeyRound,
  Eye,
  EyeOff,
  Trash2
} from 'lucide-react';
import { Courier } from '../types';

interface CourierModalProps {
  isOpen: boolean;
  onClose: () => void;
  courierToEdit?: Courier | null;
  onSave: (courierData: Partial<Courier> & { portalPassword?: string; clearPortalPassword?: boolean }) => void;
}

export const CourierModal: React.FC<CourierModalProps> = ({
  isOpen,
  onClose,
  courierToEdit,
  onSave,
}) => {
  const [name, setName] = useState('');
  const [accountsInput, setAccountsInput] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<'active' | 'idle' | 'off_duty'>('active');
  const [notes, setNotes] = useState('');
  const [portalPassword, setPortalPassword] = useState('');
  const [showPortalPassword, setShowPortalPassword] = useState(false);
  const [clearPortalPassword, setClearPortalPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setFormError(null);
    setPortalPassword('');
    setShowPortalPassword(false);
    setClearPortalPassword(false);
    if (courierToEdit) {
      setName(courierToEdit.name);
      setAccountsInput(courierToEdit.locatAccounts.join(', '));
      setPhone(courierToEdit.phone);
      setStatus(courierToEdit.status);
      setNotes(courierToEdit.notes || '');
    } else {
      setName('');
      setAccountsInput('');
      setPhone('+9665');
      setStatus('active');
      setNotes('');
    }
  }, [courierToEdit, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim() || !phone.trim()) {
      setFormError('يرجى إدخال اسم المندوب ورقم الواتساب');
      return;
    }

    if (portalPassword.trim().length > 0 && portalPassword.trim().length < 4) {
      setFormError('كلمة سر بوابة المندوب يجب أن تكون 4 أحرف أو أرقام على الأقل');
      return;
    }

    const locatAccounts = accountsInput
      .split(',')
      .map((acc) => acc.trim())
      .filter(Boolean);

    onSave({
      id: courierToEdit ? courierToEdit.id : undefined,
      name: name.trim(),
      locatAccounts: locatAccounts.length > 0 ? locatAccounts : [`drv_${Date.now().toString().slice(-4)}`],
      phone: phone.trim(),
      status,
      notes: notes.trim(),
      portalPassword: portalPassword.trim() || undefined,
      clearPortalPassword: clearPortalPassword && !portalPassword.trim() ? true : undefined,
    });

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-xl border border-slate-200">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center">
              <UserCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-slate-900">
                {courierToEdit ? 'تعديل بيانات المندوب وحساباته' : 'إضافة مندوب جديد إلى لوكيت'}
              </h2>
              <p className="text-xs text-slate-500">
                ربط حسابات لوكيت ورقم الجوال وكلمة سر بوابة المندوب
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs">
          {formError && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 font-semibold">
              {formError}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block font-bold text-slate-700 mb-1">
              اسم المندوب الثلاثي:
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: أحمد عبد الله الشمري"
              className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-400 focus:outline-none"
              required
            />
          </div>

          {/* Locat Accounts - Allows multiple accounts */}
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-200 space-y-1.5">
            <label className="block font-bold text-slate-800">
              حسابات المندوب في لوكيت (Locat Accounts / Driver IDs):
            </label>
            <p className="text-[11px] text-slate-500">
              إذا كان المندوب يتنقل بين عدة حسابات أو ورديات، أدخل أسماء الحسابات مفصولة بفاصلة (,) ليتمكن النظام من التعرف عليه تلقائياً:
            </p>
            <input
              type="text"
              value={accountsInput}
              onChange={(e) => setAccountsInput(e.target.value)}
              placeholder="مثال: ahmed_locat, DRV-101, ahmed_shift_night"
              className="w-full font-mono text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-400 focus:outline-none"
              dir="ltr"
            />
            <span className="text-[10px] text-slate-400 block">
              سيتم توجيه تنبيهات أي طلب مسند لأي من هذه الحسابات إلى نفس رقم الواتساب المسجل أدناه.
            </span>
          </div>

          {/* WhatsApp Phone */}
          <div>
            <label className="block font-bold text-slate-700 mb-1">
              رقم الجوال / الواتساب (يستخدم للدخول للبوابة والتنبيهات):
            </label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+966501234567"
              className="w-full font-mono text-sm px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-400 focus:outline-none text-left"
              dir="ltr"
              required
            />
            <span className="text-[10px] text-slate-500 mt-0.5 block">
              يجب أن يبدأ بالرمز الدولي، مثل: +966 أو 00966
            </span>
          </div>

          {/* Courier Portal Password */}
          <div className="bg-emerald-50/60 p-3.5 rounded-xl border border-emerald-200 space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-bold text-emerald-950 flex items-center gap-1.5">
                <KeyRound className="w-3.5 h-3.5 text-emerald-700" />
                <span>كلمة سر دخول المندوب لصفحته الخاصة:</span>
              </label>
              {courierToEdit?.hasPortalPassword && !clearPortalPassword && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                  مفعّلة حالياً
                </span>
              )}
            </div>
            <div className="relative">
              <input
                type={showPortalPassword ? 'text' : 'password'}
                value={portalPassword}
                onChange={(e) => {
                  setPortalPassword(e.target.value);
                  if (e.target.value) setClearPortalPassword(false);
                }}
                placeholder={
                  courierToEdit?.hasPortalPassword && !clearPortalPassword
                    ? 'اتركه فارغاً للإبقاء على كلمة السر الحالية أو اكتب كلمة سر جديدة'
                    : 'أدخل كلمة مرور (4 أحرف/أرقام على الأقل)'
                }
                className="w-full text-xs pl-9 pr-3 py-2 bg-white border border-emerald-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPortalPassword((v) => !v)}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showPortalPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            {courierToEdit?.hasPortalPassword && !portalPassword.trim() && (
              <div className="flex items-center justify-between pt-0.5">
                <span className="text-[10px] text-emerald-700">
                  {clearPortalPassword
                    ? 'سيتم إلغاء كلمة السر وتعطيل دخول المندوب عند الحفظ.'
                    : 'يمكن للمندوب الدخول برقم جواله وكلمة السر الحالية.'}
                </span>
                <button
                  type="button"
                  onClick={() => setClearPortalPassword((v) => !v)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold transition ${
                    clearPortalPassword
                      ? 'bg-slate-200 text-slate-700'
                      : 'bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200'
                  }`}
                >
                  <Trash2 className="w-2.5 h-2.5" />
                  <span>{clearPortalPassword ? 'تراجع عن الإلغاء' : 'تعطيل كلمة السر'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Status */}
          <div>
            <label className="block font-bold text-slate-700 mb-1">حالة المندوب:</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as any)}
              className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-400 focus:outline-none"
            >
              <option value="active">نشط في الميدان (يستقبل طلبات)</option>
              <option value="idle">متاح / انتظار</option>
              <option value="off_duty">خارج الوردية / إجازة</option>
            </select>
          </div>

          {/* Notes */}
          <div>
            <label className="block font-bold text-slate-700 mb-1">ملاحظات إدارية (اختياري):</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="مثال: يعمل في منطقة شمال الرياض، دراجة نارية..."
              className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-slate-400 focus:outline-none"
            />
          </div>

          {/* Actions */}
          <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg font-semibold transition"
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold flex items-center gap-1.5 transition shadow-2xs"
            >
              <Save className="w-4 h-4" />
              <span>{courierToEdit ? 'حفظ التعديلات' : 'إضافة المندوب'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
