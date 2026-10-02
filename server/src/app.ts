import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { extraRouter } from './routes/extras.js';

export const app = express();
app.use(helmet());
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 20 }));
app.use('/api/auth', authRouter);
app.use('/api', apiRouter);
app.use('/api', extraRouter);
// Never leak technical errors to users.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
