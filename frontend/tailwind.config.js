/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0a',
        surface: '#171717',
        surfaceHover: '#262626',
        primary: '#3b82f6', // Tailwind blue-500
        primaryHover: '#2563eb', // Tailwind blue-600
        textPrimary: '#f5f5f5',
        textSecondary: '#a3a3a3',
      }
    },
  },
  plugins: [],
}
