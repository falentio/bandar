import * as v from "valibot";
import { API_PREFIX } from "./api";

export const authPaths = {
  signUp: `${API_PREFIX}/auth/sign-up/email`,
  signIn: `${API_PREFIX}/auth/sign-in/email`,
  signOut: `${API_PREFIX}/auth/sign-out`,
  session: `${API_PREFIX}/auth/get-session`,
};

export const SignUpInputSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  email: v.pipe(v.string(), v.trim(), v.email()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(128)),
});

export const SignInInputSchema = v.object({
  email: v.pipe(v.string(), v.trim(), v.email()),
  password: v.pipe(v.string(), v.minLength(1)),
});

export const SessionUserSchema = v.object({
  id: v.string(),
  email: v.string(),
  name: v.string(),
});

export const SessionSchema = v.nullable(v.object({ user: SessionUserSchema }));

export const AuthResultSchema = v.object({ user: SessionUserSchema });

export const AuthErrorSchema = v.object({ message: v.string(), code: v.optional(v.string()) });

export type SignUpInput = v.InferOutput<typeof SignUpInputSchema>;

export type SignInInput = v.InferOutput<typeof SignInInputSchema>;

export type SessionUser = v.InferOutput<typeof SessionUserSchema>;

export type Session = v.InferOutput<typeof SessionSchema>;

export type AuthResult = v.InferOutput<typeof AuthResultSchema>;
