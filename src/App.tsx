import React, { useState, useEffect, useMemo, useRef } from 'react';
import { format, parseISO, isSameMonth } from 'date-fns';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend } from 'recharts';
import { AlertCircle, CheckCircle2, TrendingUp, Wallet, Banknote, IndianRupee, Moon, Sun, Edit2, X, Trash2, Loader2, Calendar, Plus, LogOut } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { auth, googleProvider } from './firebase';

// --- Types ---
interface CategoryConfig {
  _id?: string;
  name: string;
  limit: number;
  keywords: string[];
  color: string;
}

interface Expense {
  id: string;
  date: string; // ISO string
  amount: number;
  category: string;
  note: string;
}

interface AlertMessage {
  type: 'success' | 'warning' | 'error';
  message: string;
}

// --- Helper Functions ---
const parseExpenseText = (text: string, currentCategories: CategoryConfig[]): { amount: number | null; category: string } => {
  const lowerText = text.toLowerCase().replace(/[^\w\s₹$€£]/g, ' ');
  
  // Extract amount
  const amountMatch = text.match(/(?:(?:rs\.?|inr|₹|\$|€|£)\s*)?(\d+(?:\.\d+)?)/i);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : null;

  // Extract category
  let detectedCategory = currentCategories && currentCategories.length > 0 ? currentCategories[currentCategories.length - 1].name : 'Others';
  const words = lowerText.split(/\s+/);
  
  for (const cat of (currentCategories || [])) {
    if ((cat.keywords || []).some(word => words.includes(word))) {
      detectedCategory = cat.name;
      break;
    }
  }

  return { amount, category: detectedCategory };
};

const checkAnomaly = (newAmount: number, category: string, allExpenses: Expense[]): boolean => {
  const categoryExpenses = allExpenses
    .filter(e => e.category === category)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5);

  if (categoryExpenses.length === 0) return false;

  const sum = categoryExpenses.reduce((acc, curr) => acc + curr.amount, 0);
  const avg = sum / categoryExpenses.length;

  return newAmount > avg * 1.5;
};

// --- Main Component ---
export default function App() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [inputText, setInputText] = useState('');
  const [inputDate, setInputDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [alerts, setAlerts] = useState<AlertMessage[]>([]);
  const [lastAdded, setLastAdded] = useState<Expense | null>(null);
  
  // New States for Dark Mode and Budgets
  const [isDarkMode, setIsDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark';
  });
  const [categories, setCategories] = useState<CategoryConfig[]>([]);
  const [isEditingBudgets, setIsEditingBudgets] = useState(false);
  const [tempCategories, setTempCategories] = useState<CategoryConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Auth States
  const [user, setUser] = useState<User | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const dateInputRef = useRef<HTMLInputElement>(null);

  // Listen for auth state changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const token = await currentUser.getIdToken();
        setIdToken(token);
        
        // Notify backend of login to create default settings if needed
        try {
          await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        } catch (e) {
          console.error('Failed to notify backend of login', e);
        }
      } else {
        setIdToken(null);
        setExpenses([]);
        setCategories([]);
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Load from API when token is ready
  useEffect(() => {
    if (!idToken) return;

    const fetchData = async () => {
      setIsLoading(true);
      try {
        const currentMonthStr = format(new Date(), 'yyyy-MM');
        const [expensesRes, settingsRes] = await Promise.all([
          fetch(`/api/expenses?month=${currentMonthStr}`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
          }),
          fetch('/api/settings', {
            headers: { 'Authorization': `Bearer ${idToken}` }
          })
        ]);
        
        if (expensesRes.ok) {
          const data = await expensesRes.json();
          setExpenses(data);
        }
        
        if (settingsRes.ok) {
          const data = await settingsRes.json();
          setCategories(data.categories || []);
        }
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchData();
  }, [idToken]);

  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const currentMonthExpenses = useMemo(() => {
    const now = new Date();
    return expenses.filter(e => isSameMonth(parseISO(e.date), now));
  }, [expenses]);

  const categoryTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    (categories || []).forEach(c => totals[c.name] = 0);
    currentMonthExpenses.forEach(e => {
      if (totals[e.category] !== undefined) {
        totals[e.category] += e.amount;
      } else {
        totals[e.category] = e.amount;
      }
    });
    return totals;
  }, [currentMonthExpenses, categories]);

  const totalMonthlySpend = useMemo(() => {
    return (Object.values(categoryTotals) as number[]).reduce((a, b) => a + b, 0);
  }, [categoryTotals]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAlerts([]);
    setLastAdded(null);

    if (!inputText.trim()) {
      setAlerts([{ type: 'error', message: 'Please enter an expense description.' }]);
      return;
    }

    const { amount, category } = parseExpenseText(inputText, categories);

    if (amount === null || isNaN(amount) || amount <= 0) {
      setAlerts([{ type: 'error', message: 'Could not detect a valid amount. Please include a number.' }]);
      return;
    }

    const newAlerts: AlertMessage[] = [];
    
    // Check anomaly
    const isAnomaly = checkAnomaly(amount, category, expenses);
    if (isAnomaly) {
      newAlerts.push({ 
        type: 'warning', 
        message: `Unusual spending! ₹${amount} is > 1.5x your recent average for ${category}.` 
      });
    }

    // Check budget
    const currentCategoryTotal = categoryTotals[category] || 0;
    const newCategoryTotal = currentCategoryTotal + amount;
    const categoryConfig = categories.find(c => c.name === category);
    const limit = categoryConfig ? categoryConfig.limit : 0;
    
    if (limit > 0) {
      if (newCategoryTotal > limit) {
        newAlerts.push({
          type: 'error',
          message: `Budget Exceeded! You've spent ₹${newCategoryTotal} on ${category} this month (Limit: ₹${limit}).`
        });
      } else if (newCategoryTotal > limit * 0.8) {
        newAlerts.push({
          type: 'warning',
          message: `Nearing Budget! You've spent ₹${newCategoryTotal} on ${category} this month (Limit: ₹${limit}).`
        });
      }
    }

    if (newAlerts.length === 0) {
      newAlerts.push({ type: 'success', message: 'Expense added successfully!' });
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          date: inputDate,
          amount,
          category,
          note: inputText.trim(),
        }),
      });

      if (res.ok) {
        const newExpense = await res.json();
        setExpenses(prev => [newExpense, ...prev]);
        setAlerts(newAlerts);
        setLastAdded(newExpense);
        setInputText('');
      } else {
        setAlerts([{ type: 'error', message: 'Failed to save expense to database.' }]);
      }
    } catch (error) {
      setAlerts([{ type: 'error', message: 'Network error. Failed to save expense.' }]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/expenses/${id}`, { 
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (res.ok) {
        setExpenses(prev => prev.filter(e => e.id !== id));
        setAlerts([{ type: 'success', message: 'Expense deleted successfully!' }]);
      } else {
        setAlerts([{ type: 'error', message: 'Failed to delete expense.' }]);
      }
    } catch (error) {
      setAlerts([{ type: 'error', message: 'Network error. Failed to delete expense.' }]);
    } finally {
      setDeletingId(null);
    }
  };

  const handleOpenBudgetModal = () => {
    setTempCategories(JSON.parse(JSON.stringify(categories))); // Deep copy
    setIsEditingBudgets(true);
  };

  const handleSaveBudgets = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ categories: tempCategories }),
      });
      
      if (res.ok) {
        const updatedSettings = await res.json();
        setCategories(updatedSettings.categories);
        setIsEditingBudgets(false);
      }
    } catch (error) {
      console.error('Failed to update settings:', error);
    }
  };

  const handleAddCategory = () => {
    setTempCategories([
      ...tempCategories,
      { name: 'New Category', limit: 1000, keywords: [], color: '#9ca3af' }
    ]);
  };

  const handleRemoveCategory = (index: number) => {
    setTempCategories(tempCategories.filter((_, i) => i !== index));
  };

  const handleTempCategoryChange = (index: number, field: keyof CategoryConfig, value: any) => {
    const newCats = [...tempCategories];
    newCats[index] = { ...newCats[index], [field]: value };
    setTempCategories(newCats);
  };

  const getCategoryColor = (catName: string) => {
    const cat = categories.find(c => c.name === catName);
    return cat ? cat.color : '#9ca3af';
  };

  const chartData = (Object.entries(categoryTotals) as [string, number][])
    .filter(([_, value]) => value > 0)
    .map(([name, value]) => ({ name, value }));

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login failed:', error);
      alert('Login failed. Please try again.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4 transition-colors duration-200">
        <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-xl border border-gray-200 dark:border-gray-800 p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-600/20 mx-auto mb-6">
            <Wallet className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Expense Tracker</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-8">know where your money goes.</p>
          
          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-white font-medium px-6 py-4 rounded-xl transition-colors flex items-center justify-center gap-3 shadow-sm disabled:opacity-50"
          >
            {isLoggingIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans p-4 md:p-8 transition-colors duration-200">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20 shrink-0">
              <Wallet className="w-5 h-5 text-white" />
            </div>
            <div className="flex flex-col">
              <h1 className="text-xl font-bold tracking-tight leading-none mb-1">Expense Tracker</h1>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">know where your money goes.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 mr-2">
              {user?.photoURL ? (
                <img src={user.photoURL} alt={user.displayName || 'User'} className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 rounded-full flex items-center justify-center font-bold text-sm">
                  {user?.displayName?.charAt(0) || user?.email?.charAt(0) || 'U'}
                </div>
              )}
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate max-w-[120px]">
                {user?.displayName || user?.email}
              </span>
            </div>
            <button
              onClick={() => setIsDarkMode(!isDarkMode)}
              className="p-2.5 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              aria-label="Toggle Dark Mode"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={handleLogout}
              className="p-2.5 rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              aria-label="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* Command Bar */}
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-2 transition-colors relative z-10">
          <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 flex items-center px-4 bg-gray-50 dark:bg-gray-950 rounded-xl border border-transparent focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
              <Banknote className="w-5 h-5 text-gray-400 shrink-0" />
              <input
                autoFocus
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="e.g., ₹450 at Swiggy for lunch"
                className="w-full bg-transparent border-none focus:ring-0 px-3 py-4 text-gray-900 dark:text-white placeholder-gray-400 outline-none"
              />
            </div>
            <div className="flex gap-2">
              <div 
                className="relative flex items-center bg-gray-50 dark:bg-gray-950 rounded-xl border border-transparent focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 transition-all px-3 cursor-pointer"
              >
                <Calendar className="w-4 h-4 text-gray-400 shrink-0 mr-2 pointer-events-none" />
                <input
                  ref={dateInputRef}
                  type="date"
                  value={inputDate}
                  onChange={(e) => setInputDate(e.target.value)}
                  className="relative bg-transparent border-none focus:ring-0 py-4 text-gray-900 dark:text-white outline-none font-mono text-sm w-[130px] cursor-pointer [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                />
              </div>
              <button
                type="submit"
                disabled={isSubmitting}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium px-6 py-4 rounded-xl transition-colors flex items-center justify-center gap-2 shrink-0 shadow-sm shadow-blue-600/20"
              >
                {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Save'}
              </button>
            </div>
          </form>
        </div>

        {/* Alerts & Feedback */}
        <AnimatePresence>
          {(alerts.length > 0 || lastAdded) && (
            <motion.div 
              initial={{ opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, y: -10, height: 0 }}
              className="space-y-3"
            >
              {lastAdded && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/50 rounded-xl p-4 flex items-start gap-3 transition-colors">
                  <CheckCircle2 className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-blue-900 dark:text-blue-200">Parsed Successfully</p>
                    <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                      Amount: <span className="font-mono font-semibold">₹{lastAdded.amount}</span> <br/>
                      Category: <span className="font-semibold">{lastAdded.category}</span>
                    </p>
                  </div>
                </div>
              )}
              
              {alerts.map((alert, idx) => (
                <div 
                  key={idx} 
                  className={`rounded-xl p-4 flex items-start gap-3 border transition-colors ${
                    alert.type === 'error' ? 'bg-red-50 dark:bg-red-900/20 border-red-100 dark:border-red-800/50 text-red-800 dark:text-red-200' :
                    alert.type === 'warning' ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800/50 text-orange-800 dark:text-orange-200' :
                    'bg-green-50 dark:bg-green-900/20 border-green-100 dark:border-green-800/50 text-green-800 dark:text-green-200'
                  }`}
                >
                  <AlertCircle className={`w-5 h-5 shrink-0 mt-0.5 ${
                    alert.type === 'error' ? 'text-red-600 dark:text-red-400' :
                    alert.type === 'warning' ? 'text-orange-600 dark:text-orange-400' :
                    'text-green-600 dark:text-green-400'
                  }`} />
                  <p className="text-sm font-medium">{alert.message}</p>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bento Grid Dashboard */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          
          {/* Total Spend */}
          <div className="md:col-span-4 bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 flex flex-col justify-center relative overflow-hidden">
            <div className="absolute -right-6 -top-6 w-24 h-24 bg-blue-50 dark:bg-blue-900/20 rounded-full blur-2xl transition-colors"></div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400 relative z-10">Monthly Spend</p>
            <p className="text-4xl font-bold text-gray-900 dark:text-white mt-2 flex items-center font-mono tracking-tight relative z-10">
              <span className="text-gray-400 dark:text-gray-500 mr-1 font-sans font-normal text-3xl">₹</span>
              {totalMonthlySpend.toLocaleString()}
            </p>
          </div>

          {/* Budgets */}
          <div className="md:col-span-8 bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">Budget Status</h3>
              <button 
                onClick={handleOpenBudgetModal}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors text-gray-400 hover:text-gray-900 dark:hover:text-white"
                aria-label="Edit Budgets"
              >
                <Edit2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
              {(categories || []).map(cat => {
                const spent = categoryTotals[cat.name] || 0;
                const limit = cat.limit;
                const percentage = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
                
                let colorClass = "bg-blue-500 dark:bg-blue-400";
                if (percentage >= 100) colorClass = "bg-red-500 dark:bg-red-400";
                else if (percentage >= 80) colorClass = "bg-orange-500 dark:bg-orange-400";

                return (
                  <div key={cat.name} className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-gray-700 dark:text-gray-300">{cat.name}</span>
                      <span className="text-gray-500 dark:text-gray-400 font-mono text-xs mt-0.5">
                        ₹{spent.toLocaleString()} / ₹{limit.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-2 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${percentage}%` }}
                        transition={{ duration: 1, ease: "easeOut" }}
                        className={`h-full rounded-full ${colorClass}`}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Chart */}
          <div className="md:col-span-5 bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
            <h3 className="text-base font-semibold mb-6 flex items-center gap-2 text-gray-900 dark:text-white">
              <TrendingUp className="w-4 h-4 text-gray-400" />
              Spending by Category
            </h3>
            {chartData.length > 0 ? (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <PieChart>
                    <Pie
                      data={chartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {chartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={getCategoryColor(entry.name)} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value: number) => [`₹${value}`, 'Amount']}
                      contentStyle={{ 
                        borderRadius: '12px', 
                        border: '1px solid var(--color-gray-200)', 
                        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                        backgroundColor: isDarkMode ? '#111827' : '#ffffff',
                        color: isDarkMode ? '#f3f4f6' : '#111827',
                        fontFamily: 'JetBrains Mono, monospace'
                      }}
                    />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-64 flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
                No expenses this month
              </div>
            )}
          </div>

          {/* Recent Transactions */}
          <div className="md:col-span-7 bg-white dark:bg-gray-900 rounded-3xl shadow-sm border border-gray-200 dark:border-gray-800 p-6 flex flex-col">
            <h3 className="text-base font-semibold mb-4 text-gray-900 dark:text-white">Recent Transactions</h3>
            <div className="flex-1 overflow-y-auto pr-2 -mr-2 max-h-[320px]">
              {expenses.length > 0 ? (
                <div className="space-y-2">
                  <AnimatePresence initial={false}>
                    {expenses.map(expense => (
                      <motion.div 
                        key={expense.id}
                        initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                        animate={{ opacity: 1, height: 'auto', marginBottom: 8 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-2xl transition-colors group"
                      >
                        <div className="flex items-center gap-4">
                          <div 
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm"
                            style={{ backgroundColor: getCategoryColor(expense.category) }}
                          >
                            {expense.category.charAt(0)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{expense.note}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{format(parseISO(expense.date), 'MMM d, yyyy')}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold text-gray-900 dark:text-white font-mono">₹{expense.amount}</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{expense.category}</p>
                          </div>
                          <button
                            onClick={() => handleDelete(expense.id)}
                            disabled={deletingId === expense.id}
                            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                            title="Delete expense"
                          >
                            {deletingId === expense.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                          </button>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-400 dark:text-gray-600 text-sm">
                  No transactions yet
                </div>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Budget Edit Modal */}
      <AnimatePresence>
        {isEditingBudgets && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-gray-900/40 dark:bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-gray-200 dark:border-gray-800"
            >
              <div className="flex items-center justify-between p-6 border-b border-gray-100 dark:border-gray-800">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Manage Categories</h3>
                <button 
                  onClick={() => setIsEditingBudgets(false)}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
                {(tempCategories || []).map((cat, index) => (
                  <div key={index} className="space-y-3 p-4 bg-gray-50 dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 relative group">
                    <button
                      onClick={() => handleRemoveCategory(index)}
                      className="absolute top-3 right-3 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                      title="Remove Category"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    
                    <div className="grid grid-cols-2 gap-3 pr-8">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Name</label>
                        <input
                          type="text"
                          value={cat.name}
                          onChange={(e) => handleTempCategoryChange(index, 'name', e.target.value)}
                          className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Monthly Limit (₹)</label>
                        <input
                          type="number"
                          min="0"
                          value={cat.limit}
                          onChange={(e) => handleTempCategoryChange(index, 'limit', Number(e.target.value))}
                          className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm font-mono"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Keywords (comma separated)</label>
                      <input
                        type="text"
                        value={(cat.keywords || []).join(', ')}
                        onChange={(e) => handleTempCategoryChange(index, 'keywords', e.target.value.split(',').map(k => k.trim()).filter(k => k))}
                        placeholder="e.g. netflix, spotify"
                        className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                      />
                    </div>
                  </div>
                ))}
                
                <button
                  onClick={handleAddCategory}
                  className="w-full py-3 border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-2xl text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-200 dark:hover:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-all flex items-center justify-center gap-2 text-sm font-medium"
                >
                  <Plus className="w-4 h-4" />
                  Add Category
                </button>
              </div>
              <div className="p-6 bg-gray-50 dark:bg-gray-950/50 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
                <button
                  onClick={() => setIsEditingBudgets(false)}
                  className="px-5 py-2.5 rounded-xl font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveBudgets}
                  className="px-5 py-2.5 rounded-xl font-medium bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-600/20 transition-colors"
                >
                  Save Changes
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
