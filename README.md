# Kirby

Cloud control command-line tool for AWS.

It is available through npm

	npm install -g kirby

## Usage

Kirby allows you to easily launch and list named ec2 instances.
Key features include tab-completion and making launched instances automatically inherit
the configuration of an instance with the same name.

## Identifying instances

In general all commands accept a `name`, `instance-id`, `hostname` or `private hostname` to
identify an instance. If the instance name contains `+` it will be treated as an array
of different names, i.e. `name=foo+bar` means that both `foo` and `bar` will match that instance.

```
kirby list i-134245        # matches instance-id=i-134245
kirby list ec2-42-54-25... # matches hostname=ec2-42-54-25...
kirby list ip-24-24-13...  # matches private-hostname=ip-24-24-13...
kirby list a-name          # matches name=a-name or name=a-name+another-name
kirby list another-name    # matches name=another-name or name=a-name+another-name
```

## Help

Run `kirby` to see a full list of commands and options

```
Usage: kirby [command] [name-or-id?]

The available commands are
  completion  setup rich tabcompletion
              remember to source the completion or restart your terminal after setting up
                --save,-s to save it to your $BASH_COMPLETION_DIR (install globally)

  launch      launch a new instance with the given name
              the defaults for the options below are configured based
              on instances with the same name
                --ami,-i [image] to set the ami
                --key-name,-k [key-pair-name] to set the key-pair used for ssh
                --instance-type,-t [instance-type] to set the instance type
                --security-group,-g [security-group-name] to set the security group
                --availability-zone,-z [zone] to specify which availabilty zone to launch in
                --script,-s [filename] to specify a launch script
                --script,-s to specify a launch script interactively
                --iam-role,-r [role-name] to set a iam instance profile role
                --load-balancer [elb-name] to register instance with elb.
                --defaults,-d [instance-id] to set default values for options based
                  on another instance. if omitted the latest instance with the same
                  name will be used
                --no-defaults to disable defaults selection

  terminate   terminate a running instance with the given name or instance id

  exec        execute a command on all instances with the given name
              expects a script from --script [file] or --command [commands] to be used
                --command,-c [commands] to specify the command to execute inline
                --script,-s [script] to specify a script file to run
                --script,-s to specify the script interactively
                --user,-u [username] to set the user. Defaults to ubuntu
                --key,-k [path-to-private-key] to specify a private key to use for auth
                --one to only execute on the latest launched instance

  login       login to a single instance with the given name using ssh
              will prompt for the instance to login to if there are more than one.
                --key,-k [path-to-private-key] to specify a private key to use for auth
                --user,-u [username] to set the user. Defaults to ubuntu
                --one to login to the latest launched instance

  list        list all instances with the given name
                --one to only show the latest launched instance
                --running to only show running instances

  script      script the latest used launch script for the given name

  profile     list and manage profiles. use kirby profile [new-name] to add a new one
              per default the profile name default is used and all profiles are shared
              with the aws cli tools
                --aws-access-key,-a [access-key] to specify the AWS access key to use
                --aws-secret-key,-s [secret-key] to specify the AWS secret key to use
                --region,-r [region-name] to set the used region. Defaults to us-east-1

All commands accept --profile,-p [profile-name] to set the used profile to something
other than default

Running 'kirby --help' will print this message
```

## License

MIT