// Enables Tailwind's PostCSS transform for the Next.js build pipeline.
// Keeping this configuration minimal avoids hidden styling behavior.
const postcssConfig = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default postcssConfig;
