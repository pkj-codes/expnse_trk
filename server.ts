import express from 'express';
import { createServer as createViteServer } from 'vite';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize Firebase Admin
admin.initializeApp({
  projectId: 'gen-lang-client-0599743667'
});

// --- MongoDB Models ---
const expenseSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true },
  amount: { type: Number, required: true },
  category: { type: String, required: true },
  note: { type: String, required: true },
}, { timestamps: true });

const Expense = mongoose.model('Expense', expenseSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  limit: { type: Number, required: true },
  keywords: [{ type: String }],
  color: { type: String, default: '#3b82f6' }
});

const settingsSchema = new mongoose.Schema({
  userId: { type: String, default: 'default', unique: true },
  categories: [categorySchema]
});

const Settings = mongoose.model('Settings', settingsSchema);

const DEFAULT_CATEGORIES = [
  { name: 'Food', limit: 3000, keywords: ['swiggy', 'zomato', 'restaurant', 'food', 'lunch', 'dinner', 'breakfast', 'snack', 'cafe', 'coffee'], color: '#f97316' },
  { name: 'Travel', limit: 2000, keywords: ['uber', 'ola', 'bus', 'train', 'flight', 'cab', 'auto', 'petrol', 'fuel', 'ticket', 'metro'], color: '#3b82f6' },
  { name: 'Bills', limit: 5000, keywords: ['electricity', 'recharge', 'rent', 'water', 'internet', 'wifi', 'bill', 'mobile', 'gas'], color: '#ef4444' },
  { name: 'Others', limit: 2000, keywords: [], color: '#8b5cf6' }
];

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 10000;;

  // Enhance security with HTTP headers
  app.use(helmet({
    contentSecurityPolicy: false, // CSP is mostly for frontend control, disabled to allow Vite hot reload without issues
  }));

  // Limit payload size to prevent DOS from oversized payloads
  app.use(express.json({ limit: '10kb' }));

  // --- Rate Limiters ---
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5, // Limit each IP to 5 login requests per 15 mins
    message: { error: 'Too many login attempts from this IP, please try again after 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/', generalLimiter);

  // --- Connect to MongoDB ---
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI environment variable is required');
  } else {
    try {
      await mongoose.connect(MONGODB_URI);
      console.log('Connected to MongoDB');
    } catch (err) {
      console.error('Failed to connect to MongoDB:', err);
    }
  }

  // --- Auth Middleware ---
  const authMiddleware = async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      req.user = decodedToken;
      next();
    } catch (error) {
      console.error('Error verifying auth token', error);
      res.status(401).json({ error: 'Unauthorized' });
    }
  };

  // --- API Routes ---
  
  // Login route
  app.post('/api/auth/login', loginLimiter, authMiddleware, async (req: any, res: any) => {
    try {
      const userId = req.user.uid;
      // Initialize default settings if it doesn't exist for this user
      const existingSettings = await Settings.findOne({ userId });
      if (!existingSettings) {
        await Settings.create({ userId, categories: DEFAULT_CATEGORIES });
      }
      res.status(200).json({ message: 'Login successful', user: { uid: userId, email: req.user.email } });
    } catch (error) {
      res.status(500).json({ error: 'Failed to login' });
    }
  });

  // Get all expenses
  app.get('/api/expenses', authMiddleware, async (req: any, res: any) => {
    try {
      const { month, limit } = req.query;
      let query: any = { userId: req.user.uid };
      
      // Strict regex match to prevent NoSQL injection and ensure correct format
      if (month) {
        if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
          return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM.' });
        }
        query.date = { $regex: `^${month}` };
      }
      
      let dbQuery = Expense.find(query).sort({ date: -1, createdAt: -1 });
      const parsedLimit = limit ? parseInt(limit as string, 10) : 200;
      if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 1000) {
        return res.status(400).json({ error: 'Invalid limit parameter' });
      }
      dbQuery = dbQuery.limit(parsedLimit);

      const expenses = await dbQuery;
      const formattedExpenses = expenses.map(e => ({
        id: e._id.toString(),
        date: e.date,
        amount: e.amount,
        category: e.category,
        note: e.note
      }));
      res.json(formattedExpenses);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch expenses' });
    }
  });

  // Add an expense
  app.post('/api/expenses', authMiddleware, async (req: any, res: any) => {
    try {
      const { date, amount, category, note } = req.body;

      // 1. Basic validation and sanitization
      if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD.' });
      }
      if (typeof amount !== 'number' || amount <= 0 || amount > 100000000) {
        return res.status(400).json({ error: 'Amount must be a positive number and within reasonable limits.' });
      }
      if (!category || typeof category !== 'string' || category.length > 50) {
        return res.status(400).json({ error: 'Invalid or oversized category.' });
      }
      if (typeof note !== 'string' || note.length > 500) {
        return res.status(400).json({ error: 'Note must be a string and less than 500 characters.' });
      }

      // Basic anti-XSS sanitization for strings
      const sanitizedNote = note.replace(/[<>]/g, '');
      const sanitizedCategory = category.replace(/[<>]/g, '');

      // 2. Validate category against allowed categories
      const settings = await Settings.findOne({ userId: req.user.uid });
      const allowedCategories = settings 
        ? settings.categories.map((c: any) => c.name) 
        : DEFAULT_CATEGORIES.map((c: any) => c.name);
      
      if (!allowedCategories.includes(sanitizedCategory)) {
        return res.status(400).json({ error: `Category must be one of: ${allowedCategories.join(', ')}` });
      }

      const newExpense = await Expense.create({ userId: req.user.uid, date, amount, category: sanitizedCategory, note: sanitizedNote });
      res.status(201).json({
        id: newExpense._id.toString(),
        date: newExpense.date,
        amount: newExpense.amount,
        category: newExpense.category,
        note: newExpense.note
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to add expense' });
    }
  });

  // Delete an expense
  app.delete('/api/expenses/:id', authMiddleware, async (req: any, res: any) => {
    try {
      const { id } = req.params;
      const deleted = await Expense.findOneAndDelete({ _id: id, userId: req.user.uid });
      if (!deleted) {
        return res.status(404).json({ error: 'Expense not found or unauthorized' });
      }
      res.status(200).json({ message: 'Expense deleted successfully' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete expense' });
    }
  });

  // Get settings (categories)
  app.get('/api/settings', authMiddleware, async (req: any, res: any) => {
    try {
      const settings = await Settings.findOne({ userId: req.user.uid });
      if (settings) {
        res.json({ categories: settings.categories });
      } else {
        res.json({ categories: DEFAULT_CATEGORIES });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // Update settings (categories)
  app.put('/api/settings', authMiddleware, async (req: any, res: any) => {
    try {
      const { categories } = req.body;
      
      if (!Array.isArray(categories) || categories.length > 50) {
        return res.status(400).json({ error: 'Invalid categories payload. Maximum 50 categories allowed.' });
      }

      // Validate and sanitize each category
      const sanitizedCategories = [];
      for (const cat of categories) {
        if (!cat.name || typeof cat.name !== 'string' || cat.name.length > 30) {
          return res.status(400).json({ error: 'Invalid category name (max 30 characters).' });
        }
        if (typeof cat.limit !== 'number' || cat.limit < 0 || cat.limit > 100000000) {
          return res.status(400).json({ error: 'Invalid category limit.' });
        }
        if (cat.color && (typeof cat.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(cat.color))) {
          return res.status(400).json({ error: 'Invalid color hex code.' });
        }
        if (!Array.isArray(cat.keywords) || cat.keywords.length > 50) {
          return res.status(400).json({ error: 'Too many keywords (max 50).' });
        }
        
        const validKeywords = cat.keywords
          .filter((k: any) => typeof k === 'string' && k.length <= 30)
          .map((k: string) => k.replace(/[<>]/g, ''));

        sanitizedCategories.push({
          name: cat.name.replace(/[<>]/g, ''),
          limit: cat.limit,
          color: cat.color || '#3b82f6',
          keywords: validKeywords
        });
      }

      const updatedSettings = await Settings.findOneAndUpdate(
        { userId: req.user.uid },
        { categories: sanitizedCategories },
        { new: true, upsert: true }
      );
      res.json({ categories: updatedSettings.categories });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
