import tseslint from 'typescript-eslint';
import { slopRules } from '../../eslint.slop.mjs';

export default [{ ignores: ['node_modules/**'] }, ...tseslint.configs.recommended,  ...slopRules,
];
