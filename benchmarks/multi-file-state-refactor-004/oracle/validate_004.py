import os, sys

def evaluate(workspace_dir):
    score = 0
    checks = []
    
    # Check 1: Zustand Store Created
    store_file = os.path.join(workspace_dir, "src/store/studioStore.ts")
    has_store = os.path.exists(store_file)
    if has_store:
        score += 25
        checks.append(("Zustand Studio Store Created", True, 25))
    else:
        checks.append(("Zustand Studio Store Created", False, 0))

    # Check 2: Modular Slices & Atomic State
    if has_store:
        with open(store_file) as f:
            content = f.read()
        has_slices = "create" in content and ("project" in content.lower() or "title" in content) and ("timeline" in content.lower() or "seek" in content)
        if has_slices:
            score += 25
            checks.append(("Modular Slice Architecture", True, 25))
        else:
            checks.append(("Modular Slice Architecture", False, 0))
    else:
        checks.append(("Modular Slice Architecture", False, 0))

    # Check 3: Zero Circular Dependencies
    has_circular = False
    if has_store:
        with open(store_file) as f:
            content = f.read()
        if "ProjectContext" in content or "TimelineContext" in content:
            has_circular = True
    
    if not has_circular:
        score += 25
        checks.append(("Zero Circular Dependencies", True, 25))
    else:
        checks.append(("Zero Circular Dependencies", False, 0))

    # Check 4: Type Safety & Invariant Methods
    if has_store:
        with open(store_file) as f:
            content = f.read()
        has_methods = "updateTitle" in content and "seek" in content and "addClip" in content
        if has_methods:
            score += 25
            checks.append(("100% Invariant Method Signatures", True, 25))
        else:
            checks.append(("100% Invariant Method Signatures", False, 0))
    else:
        checks.append(("100% Invariant Method Signatures", False, 0))

    return score, checks

if __name__ == "__main__":
    ws = sys.argv[1] if len(sys.argv) > 1 else "."
    score, checks = evaluate(ws)
    print(f"TOTAL SCORE: {score}/100")
    for name, ok, pts in checks:
        status_label = "PASS" if ok else "FAIL"
        print(f" - [{status_label}] {name}: {pts} pts")
