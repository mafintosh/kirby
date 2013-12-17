var path = require('path');
var fs = require('fs');
var xtend = require('xtend');

var HOME = process.env.HOME || process.env.USERPROFILE;
var TTL = 24 * 3600 * 1000;

var AWS_CONFIG = path.join(HOME, '.aws', 'config');
var AWS_PROFILES = fs.existsSync(AWS_CONFIG) ? fs.readFileSync(AWS_CONFIG, 'utf-8') : '';

var KIRBY_FOLDER = path.join(HOME, '.kirby');
var KIRBY_CACHE = path.join(KIRBY_FOLDER, 'cache.json');
var KIRBY_PROFILES = path.join(KIRBY_FOLDER, 'profiles.json');

if (!fs.existsSync(KIRBY_FOLDER)) fs.mkdirSync(KIRBY_FOLDER);

AWS_PROFILES = (AWS_PROFILES.match(/\[(?:profile )?.+\]([^\[]+)/gm) || [])
	.map(function(profile) {
		var match = function(pattern) {
			return (profile.match(pattern) || [])[1];
		};

		return {
			profile: match(/\[(?:profile )?(.+)\]/i),
			'aws-access-key': match(/aws_access_key_id\s*=\s*(\S+)/i),
			'aws-secret-key': match(/aws_secret_access_key\s*=\s*(\S+)/i),
			region: match(/region\s*=\s*(\S+)/i)
		};
	})
	.reduce(function(result, profile) {
		result[profile.profile] = profile;
		return result;
	}, {});

var profiles = fs.existsSync(KIRBY_PROFILES) ? require(KIRBY_PROFILES) : {};
var cache = fs.existsSync(KIRBY_CACHE) ? require(KIRBY_CACHE) : {};

exports.defaults = function(profile, opts) {
	if (profile && typeof profile !== 'string') return exports.defaults(profile.profile, profile);
	if (!profile) profile = 'default';

	opts = xtend(AWS_PROFILES[profile], profiles[profile], opts || {});
	opts.profile = opts.profile || 'default';

	opts.cache = function(key, value) {
		key = profile+'.'+key;
		var now = Date.now();
		if (arguments.length === 1) return cache[key] && now < cache[key].mtime + TTL && cache[key].value;
		cache[key] = {mtime:now, value:value};
		fs.writeFileSync(KIRBY_CACHE, JSON.stringify(cache, null, '  '));
		return value;
	};

	return opts;
};

exports.save = function(opts) {
	opts.profile = opts.profile || 'default';
	profiles[opts.profile] = opts;

	Object.keys(opts).forEach(function(key) {
		if (opts[key] === null || opts[key] === false) delete opts[key];
	});

	fs.writeFileSync(KIRBY_PROFILES, JSON.stringify(profiles, null, '  '));
	return exports.defaults(opts);
};

exports.names = function() {
	return Object.keys(xtend(AWS_PROFILES, profiles));
};