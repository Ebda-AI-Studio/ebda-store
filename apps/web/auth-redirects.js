// Customers and old links try /account/register, /register, /signup, /login ... The real pages live under /auth/*
// (apps/web/src/app/auth/{login,register}). Without these aliases every one of them is a 404 on a storefront.
// Each alias also matches under a locale prefix (/ar/..., /en/...); the prefix is kept on the way to the real page.
const REGISTER = [
  'account/register',
  'account/signup',
  'account/sign-up',
  'register',
  'signup',
  'sign-up',
];
const LOGIN = ['account/login', 'account/signin', 'account/sign-in', 'login', 'signin', 'sign-in'];

function authRedirects() {
  const rule = (from, to) => [
    { source: `/${from}`, destination: `/auth/${to}`, permanent: false },
    { source: `/:locale(ar|en)/${from}`, destination: `/:locale/auth/${to}`, permanent: false },
  ];
  return [...REGISTER.flatMap(p => rule(p, 'register')), ...LOGIN.flatMap(p => rule(p, 'login'))];
}

module.exports = { authRedirects };
