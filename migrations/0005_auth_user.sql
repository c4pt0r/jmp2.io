-- Optional username for password-protected sites. NULL means any username is
-- accepted, which is what every existing protected site was created with.
ALTER TABLE sites ADD COLUMN auth_user TEXT;
