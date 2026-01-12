# speedplane TODO

- [ ] Implement packaging and install scripts:
  - [ ] Systemd unit file for running `speedplane` as a service.
  - [x] Default config file (e.g., `/etc/speedplane/speedplane.config`).
  - [x] Create data dir `/var/lib/speedplane` with correct permissions.

- [ ] Add authentication for API/UI (optional).
- [x] Add CSV/JSON export of history.
- [x] Add percentile/median charts and more advanced stats.
- [x] Improve scheduler UI (edit/delete schedules from frontend).


- [x] move results to the BE side
- [x] add flag/config to set the results path
- [x] add a way to delete results
- [x] sidebar when contracted should not expand when clicking on a menu link unless the user hovers over the menu link for more than 2 seconds
- [x] sidebar unless the toggle is clicked should auto collapse
- [ ] manual run should not store results in the database by default, add a preference for this, if the user enables it then the results are stored in the database
