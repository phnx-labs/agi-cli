### Fixed

- AGI Menu updates itself to a new release again. The periodic update checked
  whether the new release was signed before downloading it, so a release not
  yet on disk always failed the check and was skipped as "another install owns
  the helper". It now downloads and verifies the release first, then decides.
