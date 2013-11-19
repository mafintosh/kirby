# Kirby

Cloud control command-line tool for AWS.

It is available through npm

	npm install -g kirby

## Usage

Kirby allows you to easily launch and list named ec2 instances.
Key features include tab-completion and making launched instances automatically inherit
the configuration of an instance with the same name

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
                --ami-id,-i [image] to set the ami
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
              expects a script from stdin or --command to be used
                --command,-c [commands] to specify the command to execute inline
                --script,-s [script] to specify a script file to run
                --script,-s to specify the script interactively
                --user,-u [username] to set the user. Defaults to ubuntu
                --key,-k [path] to specify a ssh key to use for auth
                --one to only execute on the latest launched instance
                --parallel to execute the script in parallel across instances

  list        list all instances with the given name
                --one to only show the latest launched instance
                --running to only show running instances
                --select,-s [name-of-property] to only show a single property

  script      show the latest used launch script for the given name

  profile     list and manage profiles. use kirby profile [new-name] to add a new one
              per default the profile name default is used and all profiles are shared
              with the aws cli tools
                --aws-access-key,-a [access-key] to specify the AWS access key to use
                --aws-secret-key,-s [secret-key] to specify the AWS secret key to use
                --region,-r [region-name] to set the used region. Defaults to us-east-1

All commands accept --profile,-p [profile-name] to set the used profile to something
other that default

Running 'kirby --help' will print this message
```

## License

MIT