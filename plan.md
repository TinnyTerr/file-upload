You are a Staff Frontend Architect and Principal UX/UI Engineer. Your task is to refactor our vanilla JS frontend (`app/static/js/`) into a highly modular, decoupled React Single Page Application (SPA) inside the `client/` directory. 

### Core Mandate:
- **Scope Limit:** Recreate 100% of the existing functionality. Do NOT add new backend capabilities or change business rules yet.
- **Backend Safety:** Do NOT modify any Python server files. The final build must compile cleanly to the root `public/` directory for static hosting.
- **UI/UX Overhaul:** Completely trash the old layout. Build a breathtaking, modern, premium, and highly polished interface focusing on extreme usability, beauty, and future expandability.
- **Documentation:** Ignore all existing `.md` files.

---

### 1. Architectural & Modularity Constraints
To ensure this application can easily expand in the future, you must enforce a strict, decoupled architecture:

- **Feature-Based Directory Structure:** Group your files by business domain, not file type. Use this exact mapping inside `client/src/`:
  - `components/ui/` -> Atomic, generic primitives (Buttons, Inputs, Tooltips, Dropdowns, Sheets, Dialogs).
  - `features/[feature-name]/` -> Enclosed feature modules (e.g., `features/analytics/`). Inside each:
    - `components/` -> Presentational UI components specific *only* to this feature.
    - `hooks/` -> Custom React hooks handling all state, data fetching, and business logic for this feature.
    - `services/` -> Pure functions handling network requests/API boundaries for this feature.
- **Decoupled Business Logic:** UI components must be "dumb" layouts. They should accept data and callbacks exclusively via props, or by calling a single custom feature hook (e.g., `useDashboard()`). No inline API fetching or chaotic `useEffect` chains inside visual components.
- **Config-Driven UI:** Centralize application architecture (sidebar navigation links, user menu items, metadata schemas) into a `src/config/` directory. Expanding the app later should be as easy as adding an object to a configuration file.

---

### 2. UI/UX, Aesthetics, & Usability Requirements
The new UI must look like a premium, world-class SaaS application. Implement the following advanced interface patterns:

- **Design System:** Use [Tailwind CSS + Shadcn UI primitives + Lucide React icons]. Ensure a cohesive, professional color palette with high-contrast ratios, a unified typography scale, and a clean layout (e.g., a modern collapsible sidebar navigation layout with a global header).
- **Advanced Usability & Discovery:** - **Tooltips:** Every icon-only button, complex form label, and abstract metric *must* have an elegant hover tooltip explaining its purpose or exact format.
  - **Empty States:** Create gorgeous, illustrative empty states for tables, charts, or lists when no data is returned.
  - **Loading & Skeleton States:** Use high-fidelity skeleton loaders (`AnimatePresence` or CSS pulsing animations) that match the exact layout of the components they are replacing, eliminating layout shift (CLS).
- **Micro-Interactions & Feedback:** - Implement smooth, physics-based transitions for open/close states on menus, modals, and sheets (using Framer Motion if available, or Tailwind transitions).
  - Provide distinct visual states for Hover, Focus-visible, Active, and Disabled conditions on every single interactive element.
  - Add toast notifications or inline feedback alert banners for all API actions (success, failure, loading states).

---

### 3. Step-by-Step Execution Plan (Strictly Sequential)
Do not attempt to write the whole app at once. Execute in these distinct phases:

1. **Discovery & Map:** Scan the existing vanilla JS and HTML. Map the exact API routes, event handlers, and data mutations currently in use. Output a feature-based directory map showing how you plan to split the code, and list the exact features you detected. **Wait for my approval before proceeding.**
2. **Environment Setup:** Initialize the React/Vite template inside `client/`. Install Tailwind, your UI primitives, and configure the vite build pipeline to cleanly output to `../public/`.
3. **Core Shell & Components:** Build the configuration files, global layout templates (Sidebar/Navbar), and abstract UI primitives.
4. **Feature Implementation:** Migrate the functionality block-by-block, implementing the custom hooks for data logic first, followed by the presentational UI elements.
5. **Polishing & Verification:** Run a full production build, ensure zero linter/compiler errors, and verify the build populates `public/` accurately.

