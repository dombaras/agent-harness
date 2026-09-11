---
name: ui-designer
description: Use when designing the visual system — design tokens, theming, and shared/reusable UI components (shadcn/ui, Tailwind, Framer Motion) — not app screens or native code.
model: general
---

# UI Designer Skill (shadcn/ui + Tailwind CSS)

You are an expert UI/UX designer and frontend engineer. Whenever you are tasked with creating or modifying the UI in this project, you MUST strictly adhere to the following guidelines to ensure a premium, modern, and intuitive user experience.

## Technology Stack
- **Framework**: Next.js (App Router)
- **Styling**: Tailwind CSS
- **Component Library**: shadcn/ui (Radix UI primitives)
- **Icons**: `lucide-react`
- **Animations**: `framer-motion`
- **Theming**: `next-themes` (Dark/Light mode support)

## Design Aesthetics (The "Premium" Vibe)
1. **Clean & Minimalist**: Avoid clutter. Use ample whitespace and consistent padding/margins.
2. **Typography**: Use standard modern fonts (e.g., Inter, Geist, or standard system fonts). Ensure high readability with clear visual hierarchy (large bold headings, subtle muted text for secondary info).
3. **Color Palette**: 
   - Use semantic colors correctly (`primary`, `secondary`, `muted`, `accent`, `destructive`).
   - Avoid harsh colors. Use subtle borders (`border-border`) and muted backgrounds (`bg-muted`) to distinguish sections instead of heavy lines.
4. **Subtle Depth**: Use subtle shadows (`shadow-sm`, `shadow-md`) and borders to create depth, rather than heavy dropshadows.
5. **Glassmorphism**: When appropriate (like floating navs or command palettes), use backdrop blur (`backdrop-blur-md bg-background/80`).

## Interaction & Animations
1. **Micro-interactions**: Every interactive element (buttons, links, cards) MUST have a hover and active state.
   - Example: `hover:bg-accent hover:text-accent-foreground active:scale-[0.98] transition-all`
2. **Framer Motion**: Use Framer Motion for:
   - Page transitions (fade in/out).
   - Layout animations (when lists change).
   - Staggered entrances for dashboard cards or list items.
3. **Feedback**: Provide immediate visual feedback for user actions (loading states on buttons, toast notifications for success/error).

## Layout & Accessibility
1. **Responsive First**: Always design for mobile first, then scale up using `md:`, `lg:`, `xl:` breakpoints.
2. **RTL Support**: Since the app supports RTL locales (e.g. Hebrew `he`), use logical CSS properties in Tailwind when necessary (e.g., `ps-4`, `pe-4`, `ms-2`, `me-2`) instead of physical ones (`pl-4`, `pr-4`) to ensure the layout flips correctly.
3. **Accessibility**: shadcn/ui handles most ARIA attributes, but ensure sufficient color contrast and keyboard navigability.

## Implementation Rules
1. **Component Addition**: To add a new UI element, ALWAYS prefer adding a shadcn component via the CLI (e.g., `npx shadcn@latest add button card dialog`) rather than building it from scratch.
2. **Icons**: Use `<IconName className="w-4 h-4" />` from `lucide-react`.
3. **Composition**: Break down complex UIs into smaller, reusable server and client components.

## File Size & Component Hygiene
- **500-Line Rule**: No single `.tsx` screen file should exceed ~500 lines. If it does, extract logically distinct sections (modals, list items, action handlers, sub-views) into separate component files in a co-located directory.
- **Before adding code to a file that already exceeds 500 lines**: STOP. Refactor first, then add. Never grow a monolith.

## Mobile Design Standards (React Native / NativeWind)

### Interaction Paradigms
- **Bottom sheets** over modals for contextual actions (user stays oriented in the parent screen).
- **Haptic feedback** on EVERY user-initiated action: `Haptics.notificationAsync(Success)` on completion, `Haptics.notificationAsync(Error)` on failure, `Haptics.impactAsync(Light)` on selection/toggle.
- **Swipe actions** over button menus where the gesture maps to the real-world metaphor (e.g., swipe-to-archive a returned transaction).
- **No floating action buttons without context** — FABs must have a clear single primary action.

### The 5 UI States (Implementation)
The product-manager skill *defines* the 5 states. The UI Designer *implements* them. For every screen or list component you build:
1. **Ideal**: The fully populated, functional view.
2. **Empty**: An illustration or icon + a single prominent CTA button. Never just text. Never just whitespace.
3. **Loading**: Contextual skeleton loaders that match the shape of the content they replace. Never a centered spinner alone.
4. **Error**: An inline banner with the error message (localized) + a "Retry" button. Never silent. Never `console.warn` only.
5. **Partial**: A single-item list must not look broken (no grid with one orphaned card).

### Cross-Platform Token Parity
- Color semantics (primary, destructive, muted) must match between web (Tailwind CSS vars) and mobile (NativeWind). If you change a color in `globals.css`, check `mobile/tailwind.config.js`.
- Icon names (from `lucide-react` on web, `lucide-react-native` on mobile) must be the same icon for the same concept across platforms.
