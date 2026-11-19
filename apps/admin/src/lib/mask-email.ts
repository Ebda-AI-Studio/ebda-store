/** `ahmad@gmail.com` -> `a***@gmail.com`: recognisable to its owner, not readable off a shared screen. Display only. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}
