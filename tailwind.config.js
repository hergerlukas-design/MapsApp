/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        nfsBlue: '#00f2ff',
        nfsDark: '#0a0a0a',
      },
      boxShadow: {
        'neon': '0 0 15px rgba(0, 242, 255, 0.7)',
      }
    },
  },
  plugins: [],
}