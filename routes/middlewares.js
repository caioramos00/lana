'use strict';

function checkAuth(req, res, next) {
  if (req.session?.loggedIn) return next();
  return res.redirect('/login');
}

module.exports = { checkAuth };
