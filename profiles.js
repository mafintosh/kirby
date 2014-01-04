var path = require('path');
var fs = require('fs');
var xtend = require('xtend');
var ini = require('ini');

var HOME = process.env.HOME || process.env.USERPROFILE;
var TTL = 24 * 3600 * 1000;

var AWS_FOLDER = path.join(HOME, '.aws');
var AWS_CONFIG = path.join(AWS_FOLDER, 'config');
var CACHE_FOLDER = path.join(HOME, '.cache');
var CACHE_KIRBY = path.join(CACHE_FOLDER, 'kirby.json');

var profiles = ini.decode(fs.existsSync(AWS_CONFIG) ? fs.readFileSync(AWS_CONFIG, 'utf-8') : '');
var cache = fs.existsSync(CACHE_KIRBY) ? require(CACHE_KIRBY) : {};

exports.defaults = function(profile, opts) {
	if (profile && typeof profile !== 'string') return exports.defaults(profile.profile, profile);
	if (!profile) profile = 'default';

	var key = profile === 'default' ? profile : 'profile '+profile;
	var saved = profiles[key] || {};

	var prof = {
		'aws-access-key': saved.aws_access_key_id,
		'aws-secret-key': saved.aws_secret_access_key,
		region: saved.region
	};

	opts = xtend(prof, opts || {});
	opts.profile = opts.profile || 'default';

	opts.cache = function(key, value) {
		key = profile+'.'+key;
		var now = Date.now();
		if (arguments.length === 1) return cache[key] && now < cache[key].mtime + TTL && cache[key].value;
		cache[key] = {mtime:now, value:value};

		if (!fs.existsSync(CACHE_FOLDER)) fs.mkdirSync(CACHE_FOLDER);
		fs.writeFileSync(CACHE_KIRBY, JSON.stringify(cache, null, '  '));

		return value;
	};

	return opts;
};

exports.save = function(opts) {
	opts.profile = opts.profile || 'default';

	var key = opts.profile === 'default' ? opts.profile : 'profile '+opts.profile;

	var prof = profiles[key] = xtend(profiles[key], {
		aws_access_key_id: opts['aws-access-key'],
		aws_secret_access_key: opts['aws-secret-key'],
		region: opts.region
	});

	if (!prof.aws_access_key_id) delete prof.aws_access_key_id;
	if (!prof.aws_secret_access_key) delete prof.aws_secret_access_key;
	if (!prof.region) delete prof.region;

	if (!fs.existsSync(AWS_FOLDER)) fs.mkdirSync(AWS_FOLDER);
	fs.writeFileSync(AWS_CONFIG, ini.encode(profiles));

	return exports.defaults(opts);
};

exports.names = function() {
	return Object.keys(profiles).map(function(key) {
		return key.replace('profile ', '');
	});
};