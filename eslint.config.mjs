import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'build/**', 'scripts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // React hooks 规则只对渲染层生效
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    rules: {
      // 存量已清零，全部按 error 执行；确有必要的逃逸（如 IPC 边界的 any）
      // 用带理由的行内 eslint-disable 显式声明。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      'no-useless-assignment': 'error',
      'no-useless-escape': 'error',
      // 文件名/文本清洗的正则有意匹配控制字符
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
)
