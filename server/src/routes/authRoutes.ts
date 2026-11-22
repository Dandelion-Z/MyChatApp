import { Router } from 'express'
import { login, logout, refresh, register } from '../controllers/authController'
import { loginRateLimit, refreshRateLimit, registerRateLimit } from '../middleware/rateLimit'

export const authRouter = Router()

authRouter.post('/register', registerRateLimit, register)
authRouter.post('/login', loginRateLimit, login)
authRouter.post('/refresh', refreshRateLimit, refresh)
authRouter.post('/logout', logout)
