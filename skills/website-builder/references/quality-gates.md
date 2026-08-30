# Website Quality Gates

Apply the gates that match the requested deliverable. Do not claim a gate passed
without observable evidence.

## Content and conversion

- The intended audience and primary action are clear in the first meaningful view.
- Claims are specific, internally consistent, and supported by supplied evidence.
- Section order answers the audience's main questions without repetition.
- Calls to action have accurate labels, destinations, and states.
- Navigation and page hierarchy match the site's actual depth.

## Visual system

- Typography, color, spacing, grid, radius, imagery, and motion form one deliberate
  system.
- Hierarchy remains clear without relying only on color or oversized headings.
- Components have consistent alignment and complete hover, focus, disabled,
  loading, and error states when relevant.
- The design has a recognizable point of view appropriate to the brand and audience.

## Responsive behavior

- Inspect representative narrow, medium, and wide layouts; useful defaults are
  approximately 375, 768, and 1440 CSS pixels.
- No accidental horizontal overflow, clipped controls, unreadable line lengths, or
  layout-dependent content loss.
- Touch targets, menus, dialogs, tables, media, and forms remain usable on small
  screens.

## Accessibility

- Use semantic landmarks, heading order, labels, alternative text, and native
  controls where possible.
- All interactive behavior is keyboard reachable with visible focus.
- Text and controls have sufficient contrast; meaning is not conveyed by color
  alone.
- Respect reduced motion and avoid unexpected focus, audio, or animation.

## Performance and resilience

- Optimize image dimensions and formats; avoid unnecessary client-side JavaScript,
  fonts, and third-party dependencies.
- Prevent obvious layout shift and loading waterfalls.
- Handle missing content, slow requests, failures, and empty results where the page
  depends on data.
- When measurement is available, use Core Web Vitals and Lighthouse as evidence.
  Treat LCP under 2.5 seconds, CLS under 0.1, and strong accessibility/best-practice
  scores as default objectives, not unmeasured claims.

## Engineering and delivery

- Existing build, test, lint, and type-check commands pass, or failures are reported
  with their pre-existing/new status distinguished.
- Links, forms, route transitions, metadata, icons, and social previews behave as
  specified.
- Public forms validate on the server, minimize collected data, disclose its use
  and retention, and include proportionate abuse controls such as a honeypot, rate
  limit, or verified provider protection. Apply CSRF protection where the chosen
  architecture requires it; never request sensitive data without a justified flow.
- Form loading, validation, success, duplicate-submission, and recoverable error
  states are accessible and do not lose entered data unnecessarily.
- No secrets, private data, fabricated integrations, or accidental debug output are
  introduced.
- Final reporting names changed files, commands run, measured results, and remaining
  gaps. Deployment is separate and requires explicit authorization.
